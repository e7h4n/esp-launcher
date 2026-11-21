#!/usr/bin/env bash
# Migrate a 16 MB ESP32-S3 device on the classic dual-OTA layout (e.g. e7h4n/coffee-watch
# schema 2: ota_0 0x10000, ota_1 0x410000, otadata 0x810000, storage 0x812000) to
# esp-launcher's 16mb-legacy layout. NVS, phy_init, storage and the bootloader are NOT
# written, so settings and stored data survive. Run with the device idle on USB and a person
# present. Every step stops on the first error; nothing is retried.
#
#   migrate_legacy_16mb.sh PORT PARTITION_TABLE.bin LAUNCHER.bin APP.bin BACKUP_DIR
#
# PARTITION_TABLE.bin: built from firmware/partitions/16mb-legacy.csv (launcher build output)
# LAUNCHER.bin:        esp-launcher esp32s3 build (release-signed key embedded)
# APP.bin:             the app built for this layout (e.g. coffee-watch launcher variant)
set -euo pipefail
PORT=$1 PT=$2 LAUNCHER=$3 APP=$4 BACKUP_DIR=$5
ESPTOOL=${ESPTOOL:-esptool.py}
GEN=${GEN_ESP32PART:-gen_esp32part.py}
umask 077
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BK="$BACKUP_DIR/flash-16MiB-$STAMP.bin"

echo "1/6 full flash backup -> $BK"
$ESPTOOL --chip esp32s3 -p "$PORT" -b 921600 read_flash 0 0x1000000 "$BK"
shasum -a 256 "$BK" | tee "$BK.sha256"

echo "2/6 verify the current layout is the expected legacy dual-OTA table"
dd if="$BK" of="$BACKUP_DIR/pt-$STAMP.bin" bs=1 skip=$((0x8000)) count=$((0xC00)) 2>/dev/null
$GEN "$BACKUP_DIR/pt-$STAMP.bin" > "$BACKUP_DIR/pt-$STAMP.csv"
for want in "nvs,data,nvs,0x9000,24K" "phy_init,data,phy,0xf000,4K" "otadata,data,ota,0x810000,8K" "storage,data,spiffs,0x812000,8120K"; do
  grep -q "^${want}" "$BACKUP_DIR/pt-$STAMP.csv" || { echo "unexpected partition table, missing: $want"; cat "$BACKUP_DIR/pt-$STAMP.csv"; exit 1; }
done

echo "3/6 verify the new table keeps nvs/phy/otadata/storage"
$GEN "$PT" > "$BACKUP_DIR/pt-new.csv"
for want in "nvs,data,nvs,0x9000,24K" "phy_init,data,phy,0xf000,4K" "otadata,data,ota,0x810000,8K" "storage,data,spiffs,0x812000,8120K" "launcher_a,app,ota_0,0x10000," "app,app,ota_2,0x510000,"; do
  grep -q "^${want}" "$BACKUP_DIR/pt-new.csv" || { echo "new table mismatch, missing: $want"; exit 1; }
done
[ "$(stat -f%z "$APP" 2>/dev/null || stat -c%s "$APP")" -le $((0x2F0000)) ] || { echo "app too large for the 0x2F0000 slot"; exit 1; }

echo "4/6 write partition table, launcher (launcher_a) and app; erase otadata only"
$ESPTOOL --chip esp32s3 -p "$PORT" -b 921600 --before default_reset --after no_reset write_flash \
  0x8000 "$PT" 0x10000 "$LAUNCHER" 0x510000 "$APP"
$ESPTOOL --chip esp32s3 -p "$PORT" -b 921600 --before default_reset --after hard_reset erase_region 0x810000 0x2000

echo "5/6 provision over USB serial (payload on stdin of provision_serial.py)"
echo "    python3 $(dirname "$0")/provision_serial.py --port $PORT < payload.json"
echo "6/6 verify on the hub: launcher hello, then app hello with role=app"
echo "rollback: $ESPTOOL --chip esp32s3 -p $PORT -b 921600 write_flash 0 $BK"
