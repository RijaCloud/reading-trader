#!/bin/sh
set -eu

if [ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/lectures.mijary.tech" ]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi
