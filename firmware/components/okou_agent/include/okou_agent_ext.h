/*
 * okou_agent extension API - used by the esp-launcher firmware itself. Apps should not
 * need anything in here.
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "esp_partition.h"
#include "esp_http_client.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

/* NVS namespace and keys shared between launcher and SDK (docs/protocol.md). */
#define OKOU_NVS_NS          "okl"
#define OKOU_KEY_PENDING     "pending"    /* str: install args JSON + "attempts" */
#define OKOU_KEY_STAY        "stay"       /* u8: never auto-start the app */
#define OKOU_KEY_FAIL_BOOTS  "fail_boots" /* u8: app boots without a hub ack */
#define OKOU_KEY_HOLD        "hold"       /* u8: one-shot "stay in launcher on next boot" (extension) */
#define OKOU_KEY_SETUP       "setup"      /* u8: one-shot "stay in the launcher until the hub acks" */
#define OKOU_KEY_RB          "rb"         /* str: unreported rollback record (JSON) */
#define OKOU_KEY_RB_LAST     "rb_last"    /* str: label of the invalid partition already recorded */
#define OKOU_KEY_LSLOT       "lslot"      /* str: label of the last validated launcher slot (extension) */

/* Custom op handler. Fill `data` (a cJSON object, owned by the caller) and return ESP_OK,
 * or write a message into err and return an error. Runs on the agent task: must be quick. */
typedef esp_err_t (*okou_op_handler_t)(const cJSON *args, cJSON *data, char *err, size_t errlen);
/* Registers or overrides an op (e.g. the launcher overrides "install"). */
esp_err_t okou_op_register(const char *op, okou_op_handler_t handler);

typedef struct {
    void (*on_hello_acked)(void);       /* first hub ack after our hello (agent task) */
    void (*on_request)(const char *op); /* every hub req (agent task) */
} okou_hooks_t;
void okou_set_hooks(const okou_hooks_t *hooks); /* call before okou_agent_start() */

/* Called after a successful param.set (agent task). */
void okou_param_set_hook(void (*cb)(const char *name));

/* State string reported in hello/status pending_install.state (default "queued"). */
void okou_set_install_state(const char *state);

/* Queue an event; takes ownership of data (may be NULL). Never blocks. */
void okou_event_json(const char *name, cJSON *data);

/* Last validated launcher slot (okl/lslot), else factory/launcher_a/launcher_b with an image. */
const esp_partition_t *okou_launcher_partition(void);

/* Hub base URL for HTTP downloads: "https://<host>" or "http://host:port" (dev mode). */
esp_err_t okou_hub_http_base(char *buf, size_t len);
/* Adds CF-Access-* (or X-Dev-Client-Id in dev mode) headers to an HTTP request. */
void okou_http_apply_auth(esp_http_client_handle_t client);

/* Graceful reboot from the agent task after `delay_ms` (flushes logs, closes the socket). */
void okou_schedule_reboot(uint32_t delay_ms);

/* Re-read okl/{hub,cid,csec,ssid,pass,name} and reconnect (used by BLE provisioning). */
void okou_agent_reload_config(void);
bool okou_net_has_ip(void);
void okou_net_reconfigure(void); /* re-read okl/ssid+pass and reconnect Wi-Fi */
bool okou_ws_connected(void); /* socket up (hello may not be acked yet) */

/* NVS helpers (namespace okl). */
esp_err_t okou_nvs_init(void);
esp_err_t okou_nvs_get_str(const char *key, char *buf, size_t len);
char *okou_nvs_get_str_alloc(const char *key); /* malloc'd or NULL */
esp_err_t okou_nvs_set_str(const char *key, const char *val);
uint8_t okou_nvs_get_u8(const char *key, uint8_t def);
esp_err_t okou_nvs_set_u8(const char *key, uint8_t val);
esp_err_t okou_nvs_erase(const char *key);

#ifdef __cplusplus
}
#endif
