/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdbool.h>
#include "esp_err.h"
#include "esp_partition.h"
#include "cJSON.h"

esp_err_t install_op(const cJSON *args, cJSON *data, char *err, size_t errlen);
void install_resume_pending(void); /* after the hub acked hello */
bool install_running(void);
const esp_partition_t *launcher_inactive_slot(void);

void coredump_ops_register(void);

void prov_start(void);
void prov_open_window(uint32_t seconds);
