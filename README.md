# Meet Attendance Tracker

A Google Meet Add-on that tracks attendance and exports to Google Sheets. Matches Calendar invitees to participants for email resolution.

---

## Architecture

| Component | Location | Tech |
|-----------|----------|------|
| Frontend (side panel) | GitHub Pages | HTML/JS |
| Backend | Google Cloud Run | Node.js/Express |
| Data store | Google Sheets | Sheets API |
| Auth | Secret Manager + Domain-wide Delegation | Service Account JWT |

---

## Environment Variables (Cloud Run)

| Variable | Description | Example |
|----------|-------------|---------|
| `IMPERSONATE_EMAIL` | Workspace admin email to impersonate | `advertising@theyachtgroup.com` |
| `SHEET_ID` | Google Sheet ID to export attendance to | `1MvsflQvNGpCSSzd8WqFLQ80UQTuZ6Y9aohhdCIR8NoA` |
| `SECRET_NAME` | Full Secret Manager resource name | `projects/415551639811/secrets/meet-sa-key` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `https://derekgallardo01.github.io,https://meet.google.com` |

---

## Deploying the Backend

```bash
cd backend
gcloud run deploy meet-attendance-backend \
  --source . \
  --region us-central1 \
  --project the-yacht-group \
  --set-env-vars IMPERSONATE_EMAIL=advertising@theyachtgroup.com,SHEET_ID=1MvsflQvNGpCSSzd8WqFLQ80UQTuZ6Y9aohhdCIR8NoA,SECRET_NAME=projects/415551639811/secrets/meet-sa-key
```

## Deploying the Frontend

```bash
git add index.html
git commit -m "update frontend"
git push
```
GitHub Pages auto-deploys from the `main` branch. Allow 1–2 minutes to propagate.

---

## Rotating the Service Account Key

1. Go to GCP Console → IAM → Service Accounts → `meet-attendance-sa`
2. Create a new JSON key
3. Update Secret Manager:
```bash
gcloud secrets versions add meet-sa-key \
  --data-file=new-key.json \
  --project=the-yacht-group
```
4. Cloud Run will pick up the new version on next cold start (or redeploy to force it)

---

## Updating the Target Sheet

Change the `SHEET_ID` env var in Cloud Run:
```bash
gcloud run services update meet-attendance-backend \
  --update-env-vars SHEET_ID=<new-sheet-id> \
  --region us-central1 \
  --project the-yacht-group
```
Make sure `meet-attendance-sa` has Editor access on the new sheet.

---

## APIs Enabled (GCP Project: the-yacht-group)

- `meet.googleapis.com`
- `calendar-json.googleapis.com`
- `sheets.googleapis.com`
- `secretmanager.googleapis.com`

## Domain-wide Delegation Scopes (admin.google.com)

Service Account Client ID: `103579252822182721837`

- `https://www.googleapis.com/auth/meetings.space.readonly`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/calendar.readonly`
