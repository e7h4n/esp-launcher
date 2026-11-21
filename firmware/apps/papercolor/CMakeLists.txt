cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")
# CI passes -DPROJECT_VER=<major.minor>.<run number>; local builds are "<major.minor>.0-dev".
if(NOT DEFINED PROJECT_VER)
    file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/../../version.txt" _okl_base LIMIT_COUNT 1)
    set(PROJECT_VER "${_okl_base}.0-dev")
endif()
if(NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS "../../sdkconfig.common;sdkconfig.defaults")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# M5GFX 0.3.0 includes esp_psram.h without declaring the component on ESP-IDF 5.4.
idf_build_set_property(__COMPONENT_REQUIRES_COMMON esp_psram APPEND)
project(papercolor-app)
