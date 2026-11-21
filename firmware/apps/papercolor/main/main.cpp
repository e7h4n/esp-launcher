// M5Stack PaperColor app for esp-launcher.
//
//  - boot: green LED blinks 3 times and a two-tone chime right away (no screen clear at boot)
//  - power button: the PM1's own handling is left untouched (double click = immediate hardware
//    power off, like pulling the battery). A single click is acknowledged with a short beep.
//    Remote "poweroff confirm" blinks the red LED 3 times, plays a low tone and powers off.
//  - not online within 45 s (or offline for 2 min): the 4" Spectra 6 e-paper shows how to
//    provision (Chrome -> https://hub.c3p0.dev/ops/setup, BLE name okl-xxxxxx, QR code), then the
//    app hands over to the launcher (okou_enter_setup); e-paper keeps the instructions visible
//  - online: the e-paper shows Okou's color avatar, the device name and "已连接 Okou"
//
// SPDX-License-Identifier: MIT
#include <M5Unified.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "nvs.h"
extern "C" {
#include "okou_agent.h"
#include "okou_agent_ext.h"
}

static const char *TAG = "papercolor";
extern const uint8_t avatar_png_start[] asm("_binary_okou_avatar_png_start");
extern const uint8_t avatar_png_end[] asm("_binary_okou_avatar_png_end");

static const char *SETUP_URL = "https://hub.c3p0.dev/ops/setup";
static const int64_t FIRST_ONLINE_DEADLINE_US = 45LL * 1000000;
static const int64_t OFFLINE_GRACE_US = 120LL * 1000000;

enum screen_t { SCREEN_NONE, SCREEN_ONLINE, SCREEN_SETUP };
static screen_t s_screen = SCREEN_NONE;
static char s_ble_name[16];
static char s_dev_name[40];

static int64_t now_us() { return esp_timer_get_time(); }

// ---- battery (top-right of every screen) --------------------------------------------------
// Same source, curve, colours and 60 s cadence as the factory firmware's battery widget
// (paper_color web UI: GET /api/battery every 60 s, batteryPercentFromMV, low <= 25, crit <= 10).
// The Spectra 6 panel only does ~20 s full refreshes, so a sample does not redraw by itself: the
// screen is redrawn when the shown value is 10 points off, a threshold or USB power changes
// (battery-driven redraws at most every 10 min, except falling to critical).
static const int64_t BATT_SAMPLE_US = 60LL * 1000000;
static const int64_t BATT_MIN_REDRAW_US = 10LL * 60 * 1000000;
static int s_batt_pct = -1;          // current smoothed estimate
static bool s_usb = false;           // VBUS present
static int s_batt_drawn = -1;        // what the panel shows
static bool s_usb_drawn = false;
static int64_t s_batt_redraw_at = 0; // last battery-driven redraw
static int s_mv_hist[3];
static int s_mv_n = 0;

static int battery_percent_from_mv(int mv)
{
    float v = mv / 1000.0f;
    if (v >= 4.2f) return 100;
    if (v <= 3.2f) return 0;
    if (v >= 4.0f) return (int)lroundf(85 + (v - 4.0f) / 0.2f * 15);
    if (v >= 3.8f) return (int)lroundf(50 + (v - 3.8f) / 0.2f * 35);
    if (v >= 3.6f) return (int)lroundf(15 + (v - 3.6f) / 0.2f * 35);
    if (v >= 3.4f) return (int)lroundf(5 + (v - 3.4f) / 0.2f * 10);
    return (int)lroundf((v - 3.2f) / 0.2f * 5);
}

static int batt_class(int pct) { return pct < 0 ? -1 : pct <= 10 ? 2 : pct <= 25 ? 1 : 0; } // 2 crit, 1 low

static void battery_sample()
{
    int mv = (int)M5.Power.getBatteryVoltage();
    s_usb = (int)M5.Power.getVBUSVoltage() > 4000;
    if (mv <= 0) {
        return; // I2C read failed: keep the previous estimate
    }
    s_mv_hist[s_mv_n % 3] = mv;
    s_mv_n++;
    int a = s_mv_hist[0], b = s_mv_n > 1 ? s_mv_hist[1] : a, c = s_mv_n > 2 ? s_mv_hist[2] : a;
    int med = a > b ? (b > c ? b : (a > c ? c : a)) : (a > c ? a : (b > c ? c : b)); // median of 3
    s_batt_pct = battery_percent_from_mv(med);
}

static void draw_battery()
{
    auto &d = M5.Display;
    const int w = 44, h = 22, x = d.width() - w - 16, y = 14;
    int pct = s_batt_pct < 0 ? 0 : s_batt_pct;
    int cls = batt_class(s_batt_pct);
    uint32_t fill = cls == 2 ? TFT_RED : cls == 1 ? TFT_YELLOW : TFT_GREEN;
    d.drawRect(x, y, w, h, TFT_BLACK);
    d.drawRect(x + 1, y + 1, w - 2, h - 2, TFT_BLACK);
    d.fillRect(x + w, y + 6, 4, h - 12, TFT_BLACK); // terminal nub
    int fw = (w - 6) * pct / 100;
    if (fw > 0) {
        d.fillRect(x + 3, y + 3, fw, h - 6, fill);
    }
    char txt[8];
    snprintf(txt, sizeof(txt), s_batt_pct < 0 ? "--%%" : "%d%%", pct);
    d.setFont(&fonts::FreeSansBold12pt7b);
    d.setTextColor(TFT_BLACK, TFT_WHITE);
    d.setTextDatum(textdatum_t::middle_right);
    int tx = x - 8;
    d.drawString(txt, tx, y + h / 2 + 1);
    if (s_usb) { // USB power: small bolt left of the percentage
        int bx = tx - d.textWidth(txt) - 18, by = y + 1;
        d.fillTriangle(bx + 8, by, bx, by + 12, bx + 7, by + 12, TFT_BLACK);
        d.fillTriangle(bx + 5, by + 9, bx + 12, by + 9, bx + 4, by + 21, TFT_BLACK);
    }
    s_batt_drawn = s_batt_pct;
    s_usb_drawn = s_usb;
}

static bool battery_needs_redraw(int64_t t)
{
    if (s_batt_pct < 0) {
        return false;
    }
    bool usb_changed = s_usb != s_usb_drawn;
    bool to_crit = batt_class(s_batt_pct) == 2 && batt_class(s_batt_drawn) != 2;
    bool changed = usb_changed || batt_class(s_batt_pct) != batt_class(s_batt_drawn) ||
                   s_batt_drawn < 0 || abs(s_batt_pct - s_batt_drawn) >= 10;
    if (!changed) {
        return false;
    }
    if (to_crit || s_batt_redraw_at == 0) {
        return true;
    }
    return t - s_batt_redraw_at >= (usb_changed ? 60LL * 1000000 : BATT_MIN_REDRAW_US);
}

// ---- e-paper keeps its image without power: remember what is on it and skip identical redraws
static const uint8_t PM1_ADDR_REG_BTN_CFG_2 = 0x4A; // bit0 DOUBLE_OFF_DIS (M5PM1 register map)
static bool s_refreshing = false;
static screen_t s_pending_screen = SCREEN_NONE;

static void screen_sig(screen_t sc, char *out, size_t n)
{
    snprintf(out, n, "%s|%s|v1", sc == SCREEN_ONLINE ? "online" : "setup", sc == SCREEN_ONLINE ? s_dev_name : s_ble_name);
}

static bool screen_already_showing(screen_t sc)
{
    char want[64], have[64] = "";
    size_t len = sizeof(have);
    nvs_handle_t h;
    screen_sig(sc, want, sizeof(want));
    if (nvs_open("pcapp", NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    bool same = nvs_get_str(h, "screen", have, &len) == ESP_OK && strcmp(have, want) == 0;
    int32_t batt = -1;
    uint8_t usb = 0;
    nvs_get_i32(h, "batt", &batt);
    nvs_get_u8(h, "usb", &usb);
    nvs_close(h);
    if (same) { // the panel's battery widget counts as "already showing" while it is still accurate
        s_batt_drawn = batt;
        s_usb_drawn = usb != 0;
        same = !battery_needs_redraw(BATT_MIN_REDRAW_US);
    }
    return same;
}

static void remember_screen(screen_t sc)
{
    char sig[64];
    nvs_handle_t h;
    screen_sig(sc, sig, sizeof(sig));
    if (nvs_open("pcapp", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "screen", sig);
        nvs_set_i32(h, "batt", s_batt_drawn);
        nvs_set_u8(h, "usb", s_usb_drawn ? 1 : 0);
        nvs_commit(h);
        nvs_close(h);
    }
}

static void forget_screen()
{
    nvs_handle_t h;
    if (nvs_open("pcapp", NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, "screen");
        nvs_commit(h);
        nvs_close(h);
    }
}

// papercolor-app 0.1.11 disabled the PM1 hardware double-click power-off (BTN_CFG_2 bit0). That
// was wrong: the PM1's behaviour must not be overridden. Restore the default once if a device
// still carries the change; never write the register otherwise.
static void pm1_restore_double_off_default()
{
    uint8_t v = M5.Power.M5pm1.readRegister8(PM1_ADDR_REG_BTN_CFG_2);
    if (v & 0x01) {
        bool ok = M5.Power.M5pm1.bitOff(PM1_ADDR_REG_BTN_CFG_2, 0x01);
        ESP_LOGW(TAG, "PM1 double-click power-off was disabled by an older build: restored the default (%s)",
                 ok ? "ok" : "I2C error");
    } else {
        ESP_LOGI(TAG, "PM1 double-click power-off: hardware default (enabled), untouched");
    }
}

static void led_blink(uint8_t r, uint8_t g, uint8_t b, int times, int on_ms = 180, int off_ms = 180)
{
    for (int i = 0; i < times; i++) {
        M5.Led.setAllColor(r, g, b);
        M5.Led.display();
        M5.delay(on_ms);
        M5.Led.setAllColor(0, 0, 0);
        M5.Led.display();
        M5.delay(off_ms);
    }
}

static void wait_speaker()
{
    while (M5.Speaker.isPlaying()) {
        M5.delay(10);
    }
}

static void boot_chime()
{
    M5.Speaker.setVolume(180);
    M5.Speaker.tone(1568, 120); // G6
    wait_speaker();
    M5.Speaker.tone(2093, 180); // C7
    wait_speaker();
}

static void center(const char *text, int y)
{
    M5.Display.drawString(text, M5.Display.width() / 2, y);
}

static void draw_online()
{
    auto &d = M5.Display;
    ESP_LOGI(TAG, "drawing online screen (avatar)");
    d.startWrite();
    d.fillScreen(TFT_WHITE);
    draw_battery();
    size_t len = avatar_png_end - avatar_png_start;
    d.drawPng(avatar_png_start, len, (d.width() - 340) / 2, 70);
    d.setTextDatum(textdatum_t::top_center);
    d.setTextColor(TFT_BLACK, TFT_WHITE);
    d.setFont(&fonts::FreeSansBold24pt7b);
    center("Okou", 430);
    d.setFont(&fonts::efontCN_24);
    d.setTextColor(TFT_BLUE, TFT_WHITE);
    center("已连接 Okou", 500);
    d.setTextColor(TFT_BLACK, TFT_WHITE);
    d.setFont(&fonts::FreeSans9pt7b);
    center(s_dev_name, 545);
    d.endWrite();
    forget_screen(); // the panel is about to change; a reset mid-refresh must not skip the redraw
    d.display();     // starts the ~20 s Spectra 6 refresh; the main loop keeps running
    s_refreshing = true;
    s_pending_screen = SCREEN_ONLINE;
    s_screen = SCREEN_ONLINE;
    ESP_LOGI(TAG, "online screen refresh started");
}

static void draw_setup()
{
    auto &d = M5.Display;
    ESP_LOGI(TAG, "drawing setup screen");
    d.startWrite();
    d.fillScreen(TFT_WHITE);
    draw_battery();
    d.setTextDatum(textdatum_t::top_center);
    d.setFont(&fonts::efontCN_24);
    d.setTextSize(2);
    d.setTextColor(TFT_RED, TFT_WHITE);
    center("未联网", 40);
    d.setTextSize(1);
    d.setTextColor(TFT_BLACK, TFT_WHITE);
    center("请用电脑或安卓 Chrome 打开", 120);
    d.setFont(&fonts::FreeSansBold12pt7b);
    d.setTextColor(TFT_BLUE, TFT_WHITE);
    center("hub.c3p0.dev/ops/setup", 160);
    d.qrcode(SETUP_URL, (d.width() - 220) / 2, 205, 220);
    d.setFont(&fonts::efontCN_24);
    d.setTextColor(TFT_BLACK, TFT_WHITE);
    center("连接蓝牙设备", 450);
    d.setFont(&fonts::FreeSansBold18pt7b);
    center(s_ble_name, 485);
    d.setFont(&fonts::efontCN_16);
    center("配好 Wi-Fi 后会自动回到 Okou", 545);
    d.endWrite();
    forget_screen();
    d.display();
    s_refreshing = true;
    s_pending_screen = SCREEN_SETUP;
    s_screen = SCREEN_SETUP;
    ESP_LOGI(TAG, "setup screen refresh started");
}

// Called from the main loop: record the screen once the panel has finished refreshing.
static void refresh_poll(bool wait)
{
    if (!s_refreshing) {
        return;
    }
    if (wait) {
        M5.Display.waitDisplay();
    } else if (M5.Display.displayBusy()) {
        return;
    }
    s_refreshing = false;
    remember_screen(s_pending_screen);
    const char *name = s_pending_screen == SCREEN_ONLINE ? "online" : "setup";
    char js[48];
    snprintf(js, sizeof(js), "{\"screen\":\"%s\"}", name);
    okou_event("screen", js);
    ESP_LOGI(TAG, "%s screen refreshed", name);
}

// Show a screen unless the e-paper already shows exactly that (it keeps its image without power).
static void ensure_screen(screen_t sc, bool force = false)
{
    if (!force && s_screen == sc) {
        return;
    }
    if (!force && s_screen == SCREEN_NONE && screen_already_showing(sc)) {
        s_screen = sc;
        ESP_LOGI(TAG, "e-paper already shows the %s screen: no refresh", sc == SCREEN_ONLINE ? "online" : "setup");
        if (sc == SCREEN_ONLINE) {
            okou_event("screen", "{\"screen\":\"online\",\"refresh\":false}");
        }
        return;
    }
    if (s_refreshing) {
        refresh_poll(true);
    }
    if (sc == SCREEN_ONLINE) {
        draw_online();
    } else {
        draw_setup();
    }
}

static void enter_setup(const char *why)
{
    ESP_LOGW(TAG, "not online (%s): showing setup instructions and handing over to the launcher", why);
    ensure_screen(SCREEN_SETUP);
    led_blink(255, 120, 0, 2);
    refresh_poll(true); // the instructions must be on the panel before the handover
    esp_err_t e = okou_enter_setup(); // reboots into the launcher on success
    ESP_LOGE(TAG, "okou_enter_setup failed: %s", esp_err_to_name(e));
}

static void power_off(const char *why)
{
    ESP_LOGW(TAG, "power off (%s)", why);
    okou_event("power", "{\"state\":\"off\"}");
    M5.Speaker.tone(784, 220); // G5
    led_blink(255, 0, 0, 3);
    wait_speaker();
    M5.delay(300); // let the event flush
    M5.Power.powerOff();
}

// ---- remote commands (run in the main loop via okou_poll) ---------------------------------
static int cmd_beep(int argc, char **argv, okou_out_t *out)
{
    boot_chime();
    okou_outf(out, "chime played");
    return 0;
}

static int cmd_led(int argc, char **argv, okou_out_t *out)
{
    if (argc < 4) {
        okou_outf(out, "usage: led <r> <g> <b> [times]");
        return 1;
    }
    int times = argc > 4 ? atoi(argv[4]) : 3;
    led_blink(atoi(argv[1]), atoi(argv[2]), atoi(argv[3]), times > 0 && times < 20 ? times : 3);
    okou_outf(out, "blinked");
    return 0;
}

static int cmd_show(int argc, char **argv, okou_out_t *out)
{
    if (argc < 2 || (strcmp(argv[1], "online") && strcmp(argv[1], "setup"))) {
        okou_outf(out, "usage: show online|setup");
        return 1;
    }
    ensure_screen(!strcmp(argv[1], "online") ? SCREEN_ONLINE : SCREEN_SETUP, true);
    okou_outf(out, "refresh started (%s)", argv[1]);
    return 0;
}

static int cmd_offline_test(int argc, char **argv, okou_out_t *out)
{
    if (argc < 2 || strcmp(argv[1], "confirm")) {
        okou_outf(out, "usage: offline_test confirm  (draws the setup screen and enters setup mode)");
        return 1;
    }
    enter_setup("offline_test");
    okou_outf(out, "enter_setup failed");
    return 1;
}

static int cmd_poweroff(int argc, char **argv, okou_out_t *out)
{
    if (argc < 2 || strcmp(argv[1], "confirm")) {
        okou_outf(out, "usage: poweroff confirm  (needs the power button to turn on again)");
        return 1;
    }
    power_off("remote command");
    return 0;
}

static int cmd_battery(int argc, char **argv, okou_out_t *out)
{
    battery_sample();
    okou_outf(out, "battery %d%% (factory curve, median of last 3) shown %d%% usb %s | raw %d mV vbus %d mV | M5 level %d%%",
              s_batt_pct, s_batt_drawn, s_usb ? "yes" : "no", (int)M5.Power.getBatteryVoltage(),
              (int)M5.Power.getVBUSVoltage(), (int)M5.Power.getBatteryLevel());
    return 0;
}

extern "C" void app_main(void)
{
    // Network first so the device is online as early as possible and every log line is captured.
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    snprintf(s_ble_name, sizeof(s_ble_name), "okl-%02x%02x%02x", mac[3], mac[4], mac[5]);
    if (okou_nvs_init() != ESP_OK || okou_nvs_get_str("name", s_dev_name, sizeof(s_dev_name)) != ESP_OK) {
        snprintf(s_dev_name, sizeof(s_dev_name), "%s", s_ble_name);
    }
    okou_config_t ocfg = OKOU_CONFIG_DEFAULT();
    ocfg.handlers_in_poll = true; // M5 objects are used from this task only
    ESP_ERROR_CHECK(okou_agent_start(&ocfg));

    // No screen clear at boot: the e-paper keeps the last image, and a Spectra 6 full refresh takes
    // ~20-30 s of flashing. Only redraw when the content actually changes.
    auto cfg = M5.config();
    cfg.clear_display = false;
    cfg.internal_spk = true;
    M5.begin(cfg);
    ESP_LOGI(TAG, "board %d, display %dx%d", (int)M5.getBoard(), (int)M5.Display.width(), (int)M5.Display.height());
    M5.Display.setRotation(0);

    // 1 + 2: immediate boot feedback
    M5.Speaker.begin();
    led_blink(0, 200, 0, 3);
    boot_chime();
    pm1_restore_double_off_default();

    okou_cmd_register("beep", "play the boot chime", cmd_beep);
    okou_cmd_register("led", "led <r> <g> <b> [times]: blink the RGB LED", cmd_led);
    okou_cmd_register("show", "show online|setup: redraw the e-paper", cmd_show);
    okou_cmd_register("offline_test", "offline_test confirm: run the offline/setup path", cmd_offline_test);
    okou_cmd_register("poweroff", "poweroff confirm: blink and power off", cmd_poweroff);
    okou_cmd_register("battery", "battery level and voltages", cmd_battery);

    for (int i = 0; i < 3; i++) {
        battery_sample();
        M5.delay(30);
    }
    ESP_LOGI(TAG, "battery %d%% (usb %s)", s_batt_pct, s_usb ? "yes" : "no");
    int64_t batt_next = now_us() + BATT_SAMPLE_US;

    const int64_t t0 = now_us();
    int64_t offline_since = 0;
    for (;;) {
        M5.update();
        if (M5.BtnPWR.wasClicked()) {
            M5.Speaker.tone(2637, 60); // single click: acknowledge only; double click is the PM1's
        }
        okou_poll(0);
        refresh_poll(false);
        if (M5.BtnA.wasClicked() || M5.BtnB.wasClicked() || M5.BtnC.wasClicked()) {
            M5.Speaker.tone(2637, 60);
        }

        bool online = okou_connected();
        int64_t t = now_us();
        if (t >= batt_next) {
            batt_next = t + BATT_SAMPLE_US;
            battery_sample();
            okou_metric("battery_pct", s_batt_pct);
            if (s_screen != SCREEN_NONE && !s_refreshing && battery_needs_redraw(t)) {
                ESP_LOGI(TAG, "battery %d%% (shown %d%%, usb %s): redrawing", s_batt_pct, s_batt_drawn,
                         s_usb ? "yes" : "no");
                s_batt_redraw_at = t;
                ensure_screen(s_screen, true);
            }
        }
        if (online) {
            offline_since = 0;
            ensure_screen(SCREEN_ONLINE); // 4: online -> avatar
        } else if (s_screen != SCREEN_SETUP && s_screen != SCREEN_ONLINE && t - t0 > FIRST_ONLINE_DEADLINE_US) {
            enter_setup("no hub connection 45 s after boot"); // 3
        } else if (s_screen == SCREEN_ONLINE) {
            if (!offline_since) {
                offline_since = t;
            } else if (t - offline_since > OFFLINE_GRACE_US) {
                enter_setup("offline for 2 min");
            }
        }
        M5.delay(20);
    }
}
