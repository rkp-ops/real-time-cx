# CX Agent Workbench

Real-time Jira operations dashboard for the CX team. Pulls live data from all four project queues (PSS, MCQM, FHPS, OAC), auto-breaks out Whoop from PSS, flags reopened and stagnant tickets, and generates daily recaps for Slack.

## What It Does

- **Live Queue** - All open tickets across PSS, MCQM, FHPS, OAC sorted by priority. Filter by project, assignee, status. Search anything.
- **Whoop Breakout** - One-click filter to see only Whoop tickets (auto-detected from PSS by label, component, or summary).
- **Reopened Banner** - Red alert when any ticket has been reopened. Shows reopen count per ticket.
- **Stagnant Alerts** - Orange flag on any ticket with no update in 24+ hours.
- **Waiting-for-Response** - Purple indicator when the last comment was from your team (ball in their court).
- **Team Workload** - Who has how many tickets, reopened count, stagnant count per person.
- **Analytics** - Volume by project, issue type, priority, status. Hour-of-day and day-of-week charts.
- **Daily Recap** - Copy-paste Slack recap or auto-post via Zapier.
- **Auto-refresh** - Pulls fresh data every 60 seconds.

## Project Key Reference

| Key  | Name |
|------|------|
| PSS  | Partner Support Services |
| MCQM | Patient Support Services |
| FHPS | FHPS |
| OAC  | OAC |

## Deploy to Netlify (5 minutes)

### Step 1: Push to GitHub

```bash
cd cx-workbench
git init
git add .
git commit -m "CX Agent Workbench v1.0"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_ORG/cx-agent-workbench.git
git push -u origin main
```

### Step 2: Connect to Netlify

1. Go to https://app.netlify.com
2. Click "Add new site" > "Import an existing project"
3. Connect your GitHub repo
4. Build settings (should auto-detect from netlify.toml):
   - Build command: (leave blank or `echo "Static site"`)
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
5. Click "Deploy site"

### Step 3: Set Environment Variables

In Netlify: Site Settings > Environment Variables > Add:

| Variable     | Value |
|-------------|-------|
| `JIRA_DOMAIN` | `steadymd.atlassian.net` |
| `JIRA_EMAIL`  | `reba.pickeral@steadymd.com` |
| `JIRA_TOKEN`  | (your Jira API token) |

Then trigger a redeploy: Deploys > Trigger deploy > Deploy site.

### Step 4: Verify

Visit your Netlify URL. You should see live data within a few seconds. If you see "DEMO MODE", check:
- Environment variables are set correctly
- Jira API token is valid
- Your Jira user has read access to all four projects

## Set Up Zapier Slack Recap

### What It Does
Every day at 4:00 PM CT, Zapier calls the `/api/daily-recap` endpoint and posts the formatted recap to your Slack channel.

### Zapier Setup

1. Create a new Zap
2. **Trigger**: Schedule by Zapier
   - Every Day at 4:00 PM
   - Timezone: Central Time
3. **Action 1**: Webhooks by Zapier > GET
   - URL: `https://YOUR-SITE.netlify.app/api/daily-recap`
4. **Action 2**: Slack > Send Channel Message
   - Channel: (your CX channel)
   - Message Text: Use `{{text}}` from the webhook response
   - Send as Bot: Yes
   - Bot Name: CX Workbench

## Architecture

```
Browser <-> Netlify CDN (index.html)
                |
                v
        Netlify Functions
        /api/jira-proxy/queue     -> All open tickets with changelog
        /api/jira-proxy/resolved  -> Last 14 days resolved
        /api/jira-proxy/stats     -> Today's stats for recap
        /api/jira-proxy/history   -> Last 30 days for charts
        /api/daily-recap          -> Formatted Slack recap
                |
                v
        Jira REST API (steadymd.atlassian.net)
        Basic Auth (email + API token)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jira-proxy/queue` | GET | All open tickets across PSS, MCQM, FHPS, OAC with changelog |
| `/api/jira-proxy/resolved` | GET | Tickets resolved in last 14 days |
| `/api/jira-proxy/stats` | GET | Today's created/resolved/open counts |
| `/api/jira-proxy/history` | GET | Tickets created in last 30 days |
| `/api/daily-recap` | GET | Formatted Slack message for daily recap |

## Whoop Detection

Whoop tickets are automatically identified within PSS by checking:
1. Labels array contains "Whoop" (case-insensitive)
2. Components array contains "Whoop" (case-insensitive)
3. Summary contains "Whoop" or "[Whoop]"

If your Jira setup uses a different field for partner identification, update the `isWhoop` logic in `jira-proxy.js` line ~115.

## Customization

### Change refresh interval
In `index.html`, find `REFRESH_INTERVAL` (line ~7 of the script). Default is 60000ms (60 seconds).

### Add more projects
In `jira-proxy.js`, update the JQL queries to include additional project keys.

### Adjust stagnant threshold
In `jira-proxy.js`, the `isStagnant` flag triggers at 24 hours. Change `hoursSinceUpdate > 24` to your preferred threshold.

### Modify Slack recap format
Edit `daily-recap.js` to change the message structure, add/remove sections, or adjust emoji.

## Troubleshooting

**"DEMO MODE" showing in dashboard**
- Check Netlify environment variables are set
- Verify your Jira API token works: `curl -u email:token https://steadymd.atlassian.net/rest/api/3/myself`
- Check Netlify function logs: Site > Functions > jira-proxy > logs

**Slow initial load**
- The first request after deployment may take 2-3 seconds (cold start). Subsequent requests are faster.
- If you have 500+ open tickets, the pagination loop may need a moment.

**Whoop tickets not detected**
- Verify your Jira labels/components match the detection logic
- Check a sample Whoop ticket in Jira to see which field contains "Whoop"

**Zapier not posting**
- Test the endpoint manually: visit `https://YOUR-SITE.netlify.app/api/daily-recap` in a browser
- Check Zapier task history for errors
- Verify Slack channel permissions
