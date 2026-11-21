/*
 * BLE provisioning (docs/protocol.md "Provisioning (BLE)") with NimBLE.
 * Service 6f6b6f75-0001-4c61-756e-636865720000, characteristic ...0002... (write, notify).
 * Advertises as okl-<last 3 MAC bytes> only while the launcher has no hub connection or
 * during a BOOT-button window. Compile-tested only (QEMU has no BLE).
 *
 * SPDX-License-Identifier: MIT
 */
#include <string.h>
#include <stdlib.h>
#include "sdkconfig.h"
#include "launcher.h"

#if CONFIG_BT_NIMBLE_ENABLED
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "okou_agent.h"
#include "okou_agent_ext.h"

static const char *TAG = "prov";

/* 128-bit UUIDs are little-endian in NimBLE. */
static const ble_uuid128_t s_svc_uuid = BLE_UUID128_INIT(0x00, 0x00, 0x72, 0x65, 0x68, 0x63, 0x6e, 0x75, 0x61, 0x4c,
                                                         0x01, 0x00, 0x75, 0x6f, 0x6b, 0x6f);
static const ble_uuid128_t s_chr_uuid = BLE_UUID128_INIT(0x00, 0x00, 0x72, 0x65, 0x68, 0x63, 0x6e, 0x75, 0x61, 0x4c,
                                                         0x02, 0x00, 0x75, 0x6f, 0x6b, 0x6f);

#define ACC_MAX 768

static uint16_t s_val_handle;
static volatile uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint8_t s_own_addr_type;
static volatile bool s_synced, s_advertising;
static char s_acc[ACC_MAX];
static size_t s_acc_len;
static bool s_acc_overflow;
static QueueHandle_t s_lines;
static volatile int64_t s_window_until;
static char s_name[16];

static void notify(const char *s)
{
    if (s_conn == BLE_HS_CONN_HANDLE_NONE) {
        return;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(s, strlen(s));
    if (om) {
        ble_gatts_notify_custom(s_conn, s_val_handle, om);
    }
}

static int chr_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return os_mbuf_append(ctxt->om, "{}", 2) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    char tmp[256];
    uint16_t len = 0;
    if (OS_MBUF_PKTLEN(ctxt->om) > sizeof(tmp) || ble_hs_mbuf_to_flat(ctxt->om, tmp, sizeof(tmp), &len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    for (uint16_t i = 0; i < len; i++) {
        if (tmp[i] == '\n') {
            if (s_acc_overflow) {
                notify("{\"ok\":false,\"error\":\"message too long\"}");
            } else {
                s_acc[s_acc_len] = '\0';
                char *line = strdup(s_acc);
                if (line && xQueueSend(s_lines, &line, 0) != pdTRUE) {
                    free(line);
                }
            }
            s_acc_len = 0;
            s_acc_overflow = false;
        } else if (s_acc_len < ACC_MAX - 1) {
            s_acc[s_acc_len++] = tmp[i];
        } else {
            s_acc_overflow = true;
        }
    }
    return 0;
}

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]){{
                                                           .uuid = &s_chr_uuid.u,
                                                           .access_cb = chr_access,
                                                           .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_READ |
                                                                    BLE_GATT_CHR_F_NOTIFY,
                                                           .val_handle = &s_val_handle,
                                                       },
                                                       {0}},
    },
    {0},
};

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_CONNECT:
        s_advertising = false;
        if (ev->connect.status == 0) {
            s_conn = ev->connect.conn_handle;
            ESP_LOGI(TAG, "BLE client connected");
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_acc_len = 0;
        s_advertising = false;
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        s_advertising = false;
        break;
    default:
        break;
    }
    return 0;
}

static void adv_start(void)
{
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.uuids128 = &s_svc_uuid;
    f.num_uuids128 = 1;
    f.uuids128_is_complete = 1;
    if (ble_gap_adv_set_fields(&f) != 0) {
        return;
    }
    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (const uint8_t *)s_name;
    rsp.name_len = strlen(s_name);
    rsp.name_is_complete = 1;
    ble_gap_adv_rsp_set_fields(&rsp);
    struct ble_gap_adv_params p = {.conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN};
    if (ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL) == 0) {
        s_advertising = true;
        ESP_LOGI(TAG, "BLE provisioning open, advertising as %s", s_name);
    }
}

static void on_sync(void)
{
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    s_synced = true;
}

static void on_reset(int reason)
{
    s_synced = false;
    s_advertising = false;
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void prov_task(void *arg)
{
    int64_t track_until = 0;
    const char *last_state = "";
    for (;;) {
        char *line = NULL;
        if (xQueueReceive(s_lines, &line, pdMS_TO_TICKS(250)) == pdTRUE) {
            char err[96] = "";
            const char *op = prov_request_op(line);
            if (op && strcmp(op, "scan") == 0) {
                okou_ap_t *aps = calloc(20, sizeof(okou_ap_t));
                int nap = aps ? okou_wifi_scan(aps, 20, 20000) : -1;
                for (int i = 0; i < nap; i++) { /* one notification per network: fits the 185-byte MTU */
                    cJSON *o = cJSON_CreateObject(), *ap = cJSON_AddObjectToObject(o, "ap");
                    cJSON_AddStringToObject(ap, "s", aps[i].ssid);
                    cJSON_AddNumberToObject(ap, "r", aps[i].rssi);
                    cJSON_AddStringToObject(ap, "a", okou_wifi_auth_str(aps[i].auth));
                    cJSON_AddNumberToObject(ap, "c", aps[i].channel);
                    char *js = cJSON_PrintUnformatted(o);
                    cJSON_Delete(o);
                    if (js) {
                        notify(js);
                        free(js);
                    }
                    vTaskDelay(pdMS_TO_TICKS(15));
                }
                free(aps);
                char msg[48];
                snprintf(msg, sizeof(msg), "{\"scan\":\"%s\",\"n\":%d}", nap < 0 ? "failed" : "done", nap < 0 ? 0 : nap);
                notify(msg);
                free(line);
                continue;
            }
            if (op && strcmp(op, "saved") == 0) {
                cJSON *arr = cJSON_CreateArray(), *o;
                okou_wifi_saved_json(arr);
                int cnt = 0;
                cJSON_ArrayForEach(o, arr)
                {
                    cJSON *w = cJSON_CreateObject();
                    cJSON_AddItemReferenceToObject(w, "saved_ap", o);
                    char *js = cJSON_PrintUnformatted(w);
                    cJSON_Delete(w);
                    if (js) {
                        notify(js);
                        free(js);
                    }
                    cnt++;
                    vTaskDelay(pdMS_TO_TICKS(15));
                }
                cJSON_Delete(arr);
                char msg[40];
                snprintf(msg, sizeof(msg), "{\"saved\":\"done\",\"n\":%d}", cnt);
                notify(msg);
                free(line);
                continue;
            }
            if (prov_apply(line, err, sizeof(err))) {
                ESP_LOGI(TAG, "provisioning data stored");
                notify("{\"ok\":true}");
                okou_net_reconfigure();
                okou_agent_reload_config();
                track_until = esp_timer_get_time() + 60 * 1000000LL;
                last_state = "";
            } else {
                char msg[160];
                snprintf(msg, sizeof(msg), "{\"ok\":false,\"error\":\"%s\"}", err);
                notify(msg);
            }
            free(line);
        }
        int64_t now = esp_timer_get_time();
        if (track_until) {
            const char *state = !okou_net_has_ip() ? "wifi" : (!okou_connected() ? "hub" : "online");
            if (strcmp(state, last_state) != 0) {
                char msg[96];
                snprintf(msg, sizeof(msg), "{\"state\":\"%s\",\"detail\":\"\"}", state);
                notify(msg);
                last_state = state;
            }
            if (strcmp(state, "online") == 0) {
                track_until = 0;
            } else if (now > track_until) {
                notify(strcmp(state, "wifi") == 0 ? "{\"state\":\"error\",\"detail\":\"wifi timeout\"}"
                                                  : "{\"state\":\"error\",\"detail\":\"hub timeout\"}");
                track_until = 0;
            }
        }
        bool open = s_synced && (!okou_ws_connected() || now < s_window_until);
        if (open && !s_advertising && s_conn == BLE_HS_CONN_HANDLE_NONE) {
            adv_start();
        } else if (!open && s_advertising) {
            ble_gap_adv_stop();
            s_advertising = false;
            ESP_LOGI(TAG, "hub online: BLE provisioning closed");
        }
    }
}

void prov_open_window(uint32_t seconds)
{
    s_window_until = esp_timer_get_time() + (int64_t)seconds * 1000000;
}

void prov_start(void)
{
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    snprintf(s_name, sizeof(s_name), "okl-%02x%02x%02x", mac[3], mac[4], mac[5]);
    s_lines = xQueueCreate(2, sizeof(char *));
    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "NimBLE init failed; BLE provisioning unavailable");
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(s_svcs) != 0 || ble_gatts_add_svcs(s_svcs) != 0) {
        ESP_LOGE(TAG, "GATT registration failed");
        return;
    }
    ble_svc_gap_device_name_set(s_name);
    ble_att_set_preferred_mtu(185); /* status notifications exceed the 20-byte default */
    nimble_port_freertos_init(host_task);
    xTaskCreate(prov_task, "okl_prov", 4096, NULL, 2, NULL);
}

#else /* !CONFIG_BT_NIMBLE_ENABLED */

void prov_start(void)
{
}

void prov_open_window(uint32_t seconds)
{
    (void)seconds;
}

#endif
