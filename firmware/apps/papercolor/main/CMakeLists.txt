idf_component_register(SRCS "main.cpp"
    INCLUDE_DIRS "."
    REQUIRES okou_agent esp_timer nvs_flash esp_hw_support
    EMBED_FILES "okou_avatar.png")
