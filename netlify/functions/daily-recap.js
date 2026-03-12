const fetch = require('node-fetch');

const JIRA_DOMAIN = process.env.JIRA_DOMAIN || 'steadymd.atlassian.net';
const JIRA_EMAIL  = process.env.JIRA_EMAIL;
const JIRA_TOKEN  = process.env.JIRA_TOKEN;
const AUTH_HEADER  = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL     = `https://${JIRA_DOMAIN}/rest/api/3`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

async function jiraSearch({ jql, fields, maxResults = 100, expand, nextPageToken }) {
  const body = { jql, maxResults };
  if (fields) body.fields = Array.isArray(fields) ? fields : fields.split(',');
  if (expand) body.expand = String(expand);
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const url = `${BASE_URL}/search/jql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: AUTH_HEADER,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

async function jiraCount(jql) {
  const data = await jiraSearch({ jql, maxResults: 0 });
  return data.total;
}

async function jiraIssues(jql, fields, max = 50) {
  const fieldArr = Array.isArray(fields) ? fields : fields.split(',');
  const data = await jiraSearch({ jql, fields: fieldArr, maxResults: max });
  return data.issues || [];
}

exports.handler = async (event) => {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing Jira creds' }) };
  }

  try {
    const now = new Date();
    // Use Central Time for the date label
    const ctFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const dateParts = ctFormatter.formatToParts(now);
    const month = dateParts.find(p => p.type === 'month').value;
    const day = dateParts.find(p => p.type === 'day').value;
    const year = dateParts.find(p => p.type === 'year').value;
    const todayStr = `${year}-${month}-${day}`;
    const dateLabel = `${month}/${day}/${year}`;

    const projects = ['PSS', 'MCQM', 'FHPS', 'OAC'];
    const projectLabels = {
      PSS: 'Partner Support Services',
      MCQM: 'Patient Support Services',
      FHPS: 'FHPS',
      OAC: 'OAC',
    };

    // --- Aggregate counts ---
    const createdToday = await jiraCount(
      `project in (${projects.join(',')}) AND created >= "${todayStr}"`
    );
    const resolvedToday = await jiraCount(
      `project in (${projects.join(',')}) AND resolved >= "${todayStr}"`
    );
    const openBacklog = await jiraCount(
      `project in (${projects.join(',')}) AND statusCategory != Done`
    );
    const reopenedActive = await jiraCount(
      `project in (${projects.join(',')}) AND status = Reopened`
    );

    // Per-project open counts
    const projectCounts = {};
    for (const p of projects) {
      projectCounts[p] = await jiraCount(`project = ${p} AND statusCategory != Done`);
    }

    // Whoop (subset of PSS)
    const whoopIssues = await jiraIssues(
      `project = PSS AND statusCategory != Done AND (labels = Whoop OR summary ~ "Whoop")`,
      'key', 100
    );
    const whoopOpen = whoopIssues.length;

    // Stagnant (no update in 24h, still open)
    const stagnantIssues = await jiraIssues(
      `project in (${projects.join(',')}) AND statusCategory != Done AND updated <= -24h`,
      'key,summary,assignee,updated', 50
    );
    const stagnantCount = stagnantIssues.length;
    const stagnantList = stagnantIssues.slice(0, 10).map(i => {
      const assignee = i.fields?.assignee?.displayName || 'Unassigned';
      return `${i.key} (${assignee})`;
    });

    // Assignee workload
    const openIssues = await jiraIssues(
      `project in (${projects.join(',')}) AND statusCategory != Done`,
      'assignee', 200
    );
    const workload = {};
    for (const issue of openIssues) {
      const name = issue.fields?.assignee?.displayName || 'Unassigned';
      workload[name] = (workload[name] || 0) + 1;
    }
    const sortedWorkload = Object.entries(workload)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}: ${count}`);

    // --- Build Slack message ---
    const lines = [
      `:bar_chart: *CX Daily Recap - ${dateLabel}*`,
      '',
      `*Today's Numbers*`,
      `:inbox_tray: Created: *${createdToday}*  |  :white_check_mark: Resolved: *${resolvedToday}*  |  :open_file_folder: Open Backlog: *${openBacklog}*`,
      reopenedActive > 0 ? `:rotating_light: Reopened (active): *${reopenedActive}*` : ':large_green_circle: No active reopened tickets',
      '',
      `*Open by Project*`,
    ];

    for (const p of projects) {
      const label = projectLabels[p];
      let line = `  ${p} (${label}): *${projectCounts[p]}*`;
      if (p === 'PSS') line += ` (Whoop: ${whoopOpen})`;
      lines.push(line);
    }

    lines.push('');
    lines.push(`*Team Workload (Open Tickets)*`);
    for (const entry of sortedWorkload.slice(0, 8)) {
      lines.push(`  ${entry}`);
    }

    if (stagnantCount > 0) {
      lines.push('');
      lines.push(`:warning: *Stagnant Tickets (no update 24h+): ${stagnantCount}*`);
      for (const s of stagnantList) {
        lines.push(`  ${s}`);
      }
      if (stagnantCount > 10) lines.push(`  ...and ${stagnantCount - 10} more`);
    }

    lines.push('');
    lines.push(`_Auto-generated at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).format(now)} CT_`);

    const slackMessage = lines.join('\n');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        text: slackMessage,
        date: dateLabel,
        stats: {
          createdToday,
          resolvedToday,
          openBacklog,
          reopenedActive,
          projectCounts,
          whoopOpen,
          stagnantCount,
          workload,
        },
      }),
    };
  } catch (err) {
    console.error('Recap error:', err);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
