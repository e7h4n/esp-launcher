/*
 * Provisioning payload (docs/protocol.md "Provisioning"), shared by BLE and USB serial.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "okou_agent_ext.h"
#include "launcher.h"

static bool str_field(const cJSON *o, const char *k, size_t max, const char **out, char *err, size_t n)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    *out = NULL;
    if (!v) {
        return true;
    }
    if (!cJSON_IsString(v) || strlen(v->valuestring) > max) {
        snprintf(err, n, "%s must be a string of at most %u chars", k, (unsigned)max);
        return false;
    }
    *out = v->valuestring;
    return true;
}

bool prov_apply(const char *line, char *err, size_t n)
{
    cJSON *j = cJSON_Parse(line);
    if (!cJSON_IsObject(j)) {
        cJSON_Delete(j);
        snprintf(err, n, "invalid JSON");
        return false;
    }
    const cJSON *wifi = cJSON_GetObjectItemCaseSensitive(j, "wifi");
    const cJSON *tok = cJSON_GetObjectItemCaseSensitive(j, "token");
    const char *ssid = NULL, *pass = NULL, *hub = NULL, *cid = NULL, *csec = NULL, *name = NULL;
    bool ok = str_field(wifi, "ssid", 32, &ssid, err, n) && str_field(wifi, "pass", 64, &pass, err, n) &&
              str_field(j, "hub", 99, &hub, err, n) && str_field(tok, "id", 95, &cid, err, n) &&
              str_field(tok, "secret", 99, &csec, err, n) && str_field(j, "name", 32, &name, err, n);
    if (ok) {
        const char *keys[] = {"ssid", "pass", "hub", "cid", "csec", "name"};
        const char *vals[] = {ssid, pass, hub, cid, csec, name};
        for (int i = 0; i < 6 && ok; i++) {
            if (vals[i] && okou_nvs_set_str(keys[i], vals[i]) != ESP_OK) {
                snprintf(err, n, "NVS write failed (%s)", keys[i]);
                ok = false;
            }
        }
    }
    cJSON_Delete(j);
    return ok;
}

