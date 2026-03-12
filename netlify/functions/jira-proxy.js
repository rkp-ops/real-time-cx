const fetch = require('node-fetch');

// ── Env ──────────────────────────────────────────────────────
const JIRA_DOMAIN = process.env.JIRA_DOMAIN || 'steadymd.atlassian.net';
const JIRA_EMAIL  = process.env.JIRA_EMAIL;
const JIRA_TOKEN  = process.env.JIRA_TOKEN;
const AUTH_HEADER  = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL     = `https://${JIRA_DOMAIN}/rest/api/3`;

// ── CORS headers ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Helper: call Jira (GET for general endpoints) ───────────
async function jiraGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: AUTH_HEADER, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json();
}

// ── Helper: Jira search (POST /search/jql - new API) ────────
// New API uses nextPageToken instead of startAt for pagination.
// expand is a comma-separated string, fields is an array.
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

// ── Helper: paginated search (handles nextPageToken loop) ────
async function jiraSearchAll({ jql, fields, expand }) {
  let allIssues = [];
  let nextPageToken = undefined;

  while (true) {
    const data = await jiraSearch({ jql, fields, maxResults: 100, expand, nextPageToken });
    allIssues = allIssues.concat(data.issues || []);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return allIssues;
}

// ── Route: /queue  -  all open tickets across projects ───────
async function getQueue() {
  const jql = `project in (PSS, MCQM, FHPS, OAC) AND statusCategory != Done ORDER BY priority ASC, created ASC`;
  const fields = [
    'summary','status','priority','assignee','reporter','created','updated',
    'issuetype','labels','components','comment','customfield_10002',
    'customfield_10010','customfield_10020','resolution','resolutiondate',
    'description'
  ];

  const allIssues = await jiraSearchAll({ jql, fields, expand: 'changelog' });
  return allIssues.map(issue => transformIssue(issue));
}

// ── Route: /resolved  -  recently resolved (last 14 days) ───
async function getResolved() {
  const jql = `project in (PSS, MCQM, FHPS, OAC) AND statusCategory = Done AND resolved >= -14d ORDER BY resolved DESC`;
  const fields = [
    'summary','status','priority','assignee','reporter','created','updated',
    'issuetype','labels','components','comment','resolution','resolutiondate',
  ];

  const allIssues = await jiraSearchAll({ jql, fields, expand: 'changelog' });
  return allIssues.map(issue => transformIssue(issue));
}

// ── Route: /stats  -  volume stats for recap ─────────────────
async function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().split('T')[0];

  // Today's created
  const todayJql = `project in (PSS, MCQM, FHPS, OAC) AND created >= "${todayStart}" ORDER BY created DESC`;
  const todayData = await jiraSearch({
    jql: todayJql,
    fields: ['summary','status','priority','assignee','issuetype','created','labels','components'],
    maxResults: 100,
  });

  // Today's resolved
  const resolvedJql = `project in (PSS, MCQM, FHPS, OAC) AND resolved >= "${todayStart}" ORDER BY resolved DESC`;
  const resolvedData = await jiraSearch({
    jql: resolvedJql,
    fields: ['summary','status','assignee','issuetype','resolved','labels','components'],
    maxResults: 100,
  });

  // Current open count
  const openJql = `project in (PSS, MCQM, FHPS, OAC) AND statusCategory != Done`;
  const openData = await jiraSearch({
    jql: openJql,
    fields: ['key'],
    maxResults: 0,
  });

  // Reopened today
  const reopenedJql = `project in (PSS, MCQM, FHPS, OAC) AND status = Reopened`;
  const reopenedData = await jiraSearch({
    jql: reopenedJql,
    fields: ['summary','status','assignee','issuetype','created','labels'],
    maxResults: 100,
  });

  return {
    date: todayStart,
    createdToday: todayData.total,
    resolvedToday: resolvedData.total,
    openBacklog: openData.total,
    reopenedActive: reopenedData.total,
    createdIssues: (todayData.issues || []).map(i => transformIssue(i)),
    resolvedIssues: (resolvedData.issues || []).map(i => transformIssue(i)),
    reopenedIssues: (reopenedData.issues || []).map(i => transformIssue(i)),
  };
}

// ── Route: /history  -  last 30 days for charts ──────────────
async function getHistory() {
  const jql = `project in (PSS, MCQM, FHPS, OAC) AND created >= -30d ORDER BY created ASC`;
  const fields = ['summary','status','priority','assignee','issuetype','created','updated','resolutiondate','labels','components'];

  const allIssues = await jiraSearchAll({ jql, fields });
  return allIssues.map(i => transformIssue(i));
}

// ── Transform raw Jira issue to clean object ─────────────────
function transformIssue(issue) {
  const f = issue.fields || {};
  const key = issue.key;
  const projectKey = key.split('-')[0];

  // Detect Whoop: check labels, components, summary, or custom fields
  const labels = (f.labels || []).map(l => l.toLowerCase());
  const components = (f.components || []).map(c => (c.name || '').toLowerCase());
  const summary = (f.summary || '').toLowerCase();
  const isWhoop = projectKey === 'PSS' && (
    labels.includes('whoop') ||
    components.includes('whoop') ||
    summary.includes('whoop')
  );

  // Comments
  const comments = (f.comment?.comments || []).map(c => ({
    author: c.author?.displayName || 'Unknown',
    authorEmail: c.author?.emailAddress || '',
    created: c.created,
    isInternal: c.jsdPublic === false || (c.visibility && c.visibility.type === 'role'),
  }));

  // Latest comment timestamp
  const lastCommentTime = comments.length > 0 ? comments[comments.length - 1].created : null;

  // Changelog (reopens, assignee changes)
  const changelog = (issue.changelog?.histories || []);
  let reopenCount = 0;
  let assigneeChanges = 0;
  let lastReopened = null;
  const statusTransitions = [];

  for (const history of changelog) {
    for (const item of history.items || []) {
      if (item.field === 'status') {
        statusTransitions.push({
          from: item.fromString,
          to: item.toString,
          when: history.created,
        });
        if (item.toString === 'Reopened' || 
            (item.fromString === 'Done' && item.toString !== 'Done') ||
            (item.fromString === 'Closed' && item.toString !== 'Closed')) {
          reopenCount++;
          lastReopened = history.created;
        }
      }
      if (item.field === 'assignee') {
        assigneeChanges++;
      }
    }
  }

  // Stagnant detection: hours since last update
  const updatedTime = f.updated ? new Date(f.updated) : null;
  const lastActivityTime = lastCommentTime ? new Date(lastCommentTime) : updatedTime;
  const hoursSinceUpdate = updatedTime ? (Date.now() - updatedTime.getTime()) / 3600000 : null;
  const hoursSinceActivity = lastActivityTime ? (Date.now() - lastActivityTime.getTime()) / 3600000 : null;

  // Waiting for response: last comment was from internal team
  const lastComment = comments.length > 0 ? comments[comments.length - 1] : null;
  const waitingForResponse = lastComment ? lastComment.isInternal : false;

  // Cycle time (if resolved)
  const created = f.created ? new Date(f.created) : null;
  const resolved = f.resolutiondate ? new Date(f.resolutiondate) : null;
  const cycleTimeHours = (created && resolved) ? (resolved - created) / 3600000 : null;

  return {
    key,
    projectKey,
    summary: f.summary || '',
    status: f.status?.name || 'Unknown',
    statusCategory: f.status?.statusCategory?.name || 'Unknown',
    priority: f.priority?.name || 'None',
    priorityId: f.priority?.id || '5',
    issueType: f.issuetype?.name || 'Unknown',
    assignee: f.assignee?.displayName || 'Unassigned',
    assigneeEmail: f.assignee?.emailAddress || '',
    reporter: f.reporter?.displayName || 'Unknown',
    created: f.created,
    updated: f.updated,
    resolved: f.resolutiondate,
    labels: f.labels || [],
    components: (f.components || []).map(c => c.name),
    isWhoop,
    commentCount: comments.length,
    internalComments: comments.filter(c => c.isInternal).length,
    externalComments: comments.filter(c => !c.isInternal).length,
    lastCommentTime,
    lastCommentAuthor: lastComment?.author || null,
    lastCommentIsInternal: lastComment?.isInternal || false,
    waitingForResponse,
    reopenCount,
    lastReopened,
    assigneeChanges,
    statusTransitions,
    hoursSinceUpdate: hoursSinceUpdate ? Math.round(hoursSinceUpdate * 10) / 10 : null,
    hoursSinceActivity: hoursSinceActivity ? Math.round(hoursSinceActivity * 10) / 10 : null,
    cycleTimeHours: cycleTimeHours ? Math.round(cycleTimeHours * 10) / 10 : null,
    isStagnant: hoursSinceUpdate !== null && hoursSinceUpdate > 24,
    isReopened: (f.status?.name || '').toLowerCase() === 'reopened' || reopenCount > 0,
    jiraUrl: `https://${JIRA_DOMAIN}/browse/${key}`,
  };
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'JIRA_EMAIL and JIRA_TOKEN env vars are required.' }),
    };
  }

  const path = event.path.replace('/.netlify/functions/jira-proxy', '').replace('/api/jira-proxy', '');
  const route = path || '/queue';

  try {
    let data;
    switch (route) {
      case '/queue':
        data = await getQueue();
        break;
      case '/resolved':
        data = await getResolved();
        break;
      case '/stats':
        data = await getStats();
        break;
      case '/history':
        data = await getHistory();
        break;
      default:
        return {
          statusCode: 404,
          headers: CORS,
          body: JSON.stringify({ error: `Unknown route: ${route}` }),
        };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('Jira proxy error:', err);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
