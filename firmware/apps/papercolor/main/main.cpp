// M5Stack PaperColor app for esp-launcher.
//
//  - boot: two-tone chime on the speaker, green LED blinks 3 times
//  - power button click (or remote "poweroff confirm"): red LED blinks 3 times, low tone, power off
//  - not online within 45 s (or offline for 2 min): the 4" Spectra 6 e-paper shows how to
//    provision (Chrome -> https://hub.c3p0.dev/ops/setup, BLE name okl-xxxxxx, QR code), then the
//    app hands over to the launcher (okou_enter_setup); e-paper keeps the instructions visible
//  - online: the e-paper shows Okou's color avatar, the device name and "已连接 Okou"
//
// SPDX-License-Identifier: MIT
#include <M5Unified.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
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
    d.display();
    d.waitDisplay();
    s_screen = SCREEN_ONLINE;
    okou_event("screen", "{\"screen\":\"online\"}");
    ESP_LOGI(TAG, "online screen refreshed");
}

static void draw_setup()
{
    auto &d = M5.Display;
    ESP_LOGI(TAG, "drawing setup screen");
    d.startWrite();
    d.fillScreen(TFT_WHITE);
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
    d.display();
    d.waitDisplay();
    s_screen = SCREEN_SETUP;
    ESP_LOGI(TAG, "setup screen refreshed");
}

static void enter_setup(const char *why)
{
    ESP_LOGW(TAG, "not online (%s): showing setup instructions and handing over to the launcher", why);
    if (s_screen != SCREEN_SETUP) {
        draw_setup();
    }
    led_blink(255, 120, 0, 2);
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
    if (!strcmp(argv[1], "online")) {
        draw_online();
    } else {
        draw_setup();
    }
    okou_outf(out, "refreshed (%s)", argv[1]);
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
    okou_outf(out, "level %d%% voltage %d mV vbus %d mV", (int)M5.Power.getBatteryLevel(), (int)M5.Power.getBatteryVoltage(),
              (int)M5.Power.getVBUSVoltage());
    return 0;
}

extern "C" void app_main(void)
{
    M5.begin();
    ESP_LOGI(TAG, "board %d, display %dx%d", (int)M5.getBoard(), (int)M5.Display.width(), (int)M5.Display.height());
    M5.Display.setRotation(0);

    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    snprintf(s_ble_name, sizeof(s_ble_name), "okl-%02x%02x%02x", mac[3], mac[4], mac[5]);
    if (okou_nvs_init() != ESP_OK || okou_nvs_get_str("name", s_dev_name, sizeof(s_dev_name)) != ESP_OK) {
        snprintf(s_dev_name, sizeof(s_dev_name), "%s", s_ble_name);
    }

    // 1 + 2: boot chime and green blinks
    led_blink(0, 200, 0, 3);
    boot_chime();

    okou_config_t cfg = OKOU_CONFIG_DEFAULT();
    cfg.handlers_in_poll = true; // M5 objects are used from this task only
    ESP_ERROR_CHECK(okou_agent_start(&cfg));
    okou_cmd_register("beep", "play the boot chime", cmd_beep);
    okou_cmd_register("led", "led <r> <g> <b> [times]: blink the RGB LED", cmd_led);
    okou_cmd_register("show", "show online|setup: redraw the e-paper", cmd_show);
    okou_cmd_register("offline_test", "offline_test confirm: run the offline/setup path", cmd_offline_test);
    okou_cmd_register("poweroff", "poweroff confirm: blink and power off", cmd_poweroff);
    okou_cmd_register("battery", "battery level and voltages", cmd_battery);

    const int64_t t0 = now_us();
    int64_t offline_since = 0;
    for (;;) {
        M5.update();
        okou_poll(0);

        if (M5.BtnPWR.wasClicked()) {
            power_off("power button");
        }
        if (M5.BtnA.wasClicked() || M5.BtnB.wasClicked() || M5.BtnC.wasClicked()) {
            M5.Speaker.tone(2637, 60);
        }

        bool online = okou_connected();
        int64_t t = now_us();
        if (online) {
            offline_since = 0;
            if (s_screen != SCREEN_ONLINE) {
                draw_online(); // 3/4: online -> avatar
            }
        } else if (s_screen == SCREEN_NONE && t - t0 > FIRST_ONLINE_DEADLINE_US) {
            enter_setup("no hub connection 45 s after boot");
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
