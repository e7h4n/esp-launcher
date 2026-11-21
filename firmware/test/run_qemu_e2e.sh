#!/usr/bin/env bash
# QEMU end-to-end test wrapper.
#
#   test/run_qemu_e2e.sh [--mock] [--build] [--hub-url URL] [extra qemu_e2e.py args]
#
#   --mock     start test/mock_hub.py on 127.0.0.1:8787 (CI; no Cloudflare)
#   --build    (re)build launcher + hello_app for esp32 QEMU first
#   default    use an already running hub (e.g. `cd hub && npm run dev`, DEV_INSECURE=1)
#
# Needs ESP-IDF v5.4.x exported (IDF_PATH, idf.py, qemu-system-xtensa on PATH).
set -euo pipefail
FW=$(cd "$(dirname "$0")/.." && pwd)
MOCK=0 BUILD=0 HUB_URL=http://127.0.0.1:8787
EXTRA=()
while [ $# -gt 0 ]; do
    case "$1" in
        --mock) MOCK=1 ;;
        --build) BUILD=1 ;;
        --hub-url) HUB_URL=$2; shift ;;
        *) EXTRA+=("$1") ;;
    esac
    shift
done
: "${IDF_PATH:?source \$IDF_PATH/export.sh first}"

if [ $BUILD -eq 1 ]; then
    (cd "$FW/launcher" && idf.py -B build/esp32-qemu -DIDF_TARGET=esp32 -DSDKCONFIG=build/esp32-qemu/sdkconfig \
        -DSDKCONFIG_DEFAULTS="../sdkconfig.common;sdkconfig.defaults;../sdkconfig.qemu" build)
    (cd "$FW/examples/hello_app" && idf.py -B build/esp32-qemu -DIDF_TARGET=esp32 \
        -DSDKCONFIG=build/esp32-qemu/sdkconfig \
        -DSDKCONFIG_DEFAULTS="../../sdkconfig.common;sdkconfig.defaults;../../sdkconfig.qemu" build)
fi

HUB_PID=
cleanup() { [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$FW/test/out"
if [ $MOCK -eq 1 ]; then
    python3 "$FW/test/mock_hub.py" --port 8787 -v > "$FW/test/out/mock_hub.log" 2>&1 &
    HUB_PID=$!
    HUB_URL=http://127.0.0.1:8787
fi
for _ in $(seq 1 30); do
    if python3 -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1] + '/ops/devices', timeout=2)" \
        "$HUB_URL" 2>/dev/null; then
        break
    fi
    sleep 1
done
python3 "$FW/test/qemu_e2e.py" --hub-url "$HUB_URL" ${EXTRA[@]+"${EXTRA[@]}"}
