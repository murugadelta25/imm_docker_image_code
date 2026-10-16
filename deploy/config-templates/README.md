# Deploy configuration templates

These files are **sanitized** copies of site settings and email alert routing (groups, recipients, schedules). They do **not** contain SMTP passwords or MySQL credentials.

## Refresh from a running dev instance (Windows or Ubuntu)

```bash
# Windows
.\scripts\backup-settings.ps1

# Ubuntu
chmod +x scripts/backup-settings.sh
./scripts/backup-settings.sh
```

Then commit `app_config_bundle.json`, `site_config.json`, and `email_alerts.json`.

## Ubuntu server — first deploy

```bash
git clone https://github.com/murugadelta25/eap_imm_pms.git
cd eap_imm_pms
cp deploy.env.example deploy.env   # edit domain, ports if needed
chmod +x run.sh scripts/*.sh
./run.sh
```

On first run, `scripts/setup-database.sh` will:

1. Create the MySQL database (from prompts / `deploy.env`)
2. Apply `database/schema.sql` and migration scripts
3. Run `backend/ensure_customer_db.py` (schema guard + optional config import)
4. Import `deploy/config-templates/app_config_bundle.json` when site/email tables are empty

## Gmail SMTP (after pull)

1. Open **Email Alerts** in the UI
2. Set SMTP server `smtp.gmail.com`, port `587`, sender address, and a [Google App Password](https://support.google.com/accounts/answer/185833)
3. Use **Test SMTP** or manual send with report attachments

Verify report builders without sending mail:

```bash
python3 scripts/verify_email_reports.py
python3 scripts/verify_email_reports.py --write-samples
python3 scripts/verify_email_reports.py --send-test you@example.com
```

## Files

| File | Purpose |
|------|---------|
| `app_config_bundle.json` | Single import bundle used by `scripts/import_app_config.py` |
| `site_config.json` | Site / factory JSON (review diffs) |
| `email_alerts.json` | Groups, recipients, schedules, SMTP template (no password) |
