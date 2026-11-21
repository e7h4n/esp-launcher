/* hello_app - minimal app linking the okou_agent SDK. SPDX-License-Identifier: MIT */
#include <stdlib.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "okou_agent.h"

static const char *TAG = "hello";
static int32_t s_period_ms = 2000;
static int32_t s_crash_boots; /* test hook: crash this many upcoming boots before the hub ack */

static int cmd_echo(int argc, char **argv, okou_out_t *out)
{
    for (int i = 1; i < argc; i++) {
        okou_outf(out, "%s%s", i > 1 ? " " : "", argv[i]);
    }
    return 0;
}

static void crash_now(void *arg)
{
    ESP_LOGE(TAG, "deliberate crash (abort)");
    abort();
}

/* Answer first, then abort from a timer so the operator still gets a res. */
static int cmd_crash(int argc, char **argv, okou_out_t *out)
{
    static esp_timer_handle_t t;
    const esp_timer_create_args_t a = {.callback = crash_now, .name = "crash"};
    if (!t && esp_timer_create(&a, &t) != ESP_OK) {
        return 1;
    }
    esp_timer_start_once(t, 300 * 1000);
    okou_outf(out, "aborting in 300 ms");
    return 0;
}

void app_main(void)
{
    okou_param_int("period_ms", &s_period_ms, 200, 10000, true);
    okou_cmd_register("echo", "echo arguments back", cmd_echo);
    okou_cmd_register("crash", "abort() after 300 ms (rollback test)", cmd_crash);
    okou_param_int("crash_boots", &s_crash_boots, 0, 5, true);
    ESP_ERROR_CHECK(okou_agent_start(NULL));
    if (s_crash_boots > 0) { /* rollback / fail_boots testing: die before the hub can ack */
        s_crash_boots--;
        okou_param_save("crash_boots");
        ESP_LOGE(TAG, "crash_boots: aborting before hub ack (%" PRId32 " more)", s_crash_boots);
        vTaskDelay(pdMS_TO_TICKS(100));
        abort();
    }

    for (uint32_t counter = 0;; counter++) {
        ESP_LOGI(TAG, "heartbeat %" PRIu32 " period_ms=%" PRId32, counter, s_period_ms);
        okou_metric("counter", counter);
        vTaskDelay(pdMS_TO_TICKS(s_period_ms));
    }
}
