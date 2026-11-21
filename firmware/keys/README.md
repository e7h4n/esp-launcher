# firmware/keys

| File | Purpose |
|---|---|
| `dev_priv.pem` | **TEST ONLY** ECDSA P-256 private key. Committed on purpose so QEMU/CI tests can sign images. Never sign a release with it. |
| `dev_pub.pem` | Public half of the dev key. Embedded when `CONFIG_OKL_KEY_DEV=y` (QEMU builds set this). |
| `release_pub.pem` | Public key embedded in release launchers (`CONFIG_OKL_KEY_RELEASE=y`, the default). Real release key (generated 2026-11-21). The private key exists only as the GitHub Actions secret `FIRMWARE_SIGNING_KEY`; only CI can sign release images. |

Generate a release key pair (keep the private key offline / in the secret store only):

    openssl ecparam -name prime256v1 -genkey -noout -out release_priv.pem
    openssl ec -in release_priv.pem -pubout -out release_pub.pem
