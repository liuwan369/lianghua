#!/bin/sh
set -eu
ln -sfn /etc/nginx/sites-available/pm-dashboard-renew-http /etc/nginx/sites-enabled/pm-dashboard-public
nginx -t >/dev/null 2>&1
systemctl reload nginx
