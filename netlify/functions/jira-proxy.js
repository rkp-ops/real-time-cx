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

// ── Route: /history  -  date-range search (default: 30 days, max: 6 months) ──
async function getHistory(params = {}) {
  const now = new Date();
  const sixMonthsAgo = new Date(now); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Parse from/to params, default to last 30 days, cap at 6 months
  let from = params.from ? new Date(params.from) : thirtyDaysAgo;
  let to = params.to ? new Date(params.to + 'T23:59:59') : now;
  if (from < sixMonthsAgo) from = sixMonthsAgo;
  if (to > now) to = now;

  const fromStr = from.toISOString().split('T')[0];
  const toStr = to.toISOString().split('T')[0];

  const fields = ['summary','status','priority','assignee','reporter','issuetype','created','updated','resolutiondate','labels','components','customfield_10942'];

  // Fetch all 4 projects in PARALLEL for speed (avoids function timeout on large ranges)
  console.log(`[history] Fetching: ${fromStr} to ${toStr} (parallel by project)`);
  const projects = ['PSS', 'MCQM', 'FHPS', 'OAC'];
  const results = await Promise.all(projects.map(p =>
    jiraSearchAll({
      jql: `project = ${p} AND created >= "${fromStr}" AND created <= "${toStr}" ORDER BY created DESC`,
      fields,
    }).then(issues => {
      console.log(`[history] ${p}: ${issues.length} tickets`);
      return issues;
    })
  ));
  const allIssues = results.flat();
  // Sort combined results by created DESC
  allIssues.sort((a, b) => new Date(b.fields?.created || 0) - new Date(a.fields?.created || 0));
  console.log(`[history] Total: ${allIssues.length} tickets`);
  return {
    tickets: allIssues.map(i => transformIssue(i)),
    meta: { from: fromStr, to: toStr, total: allIssues.length },
  };
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
  const reopenTimestamps = [];
  const FINAL_STATUSES = ['done', 'closed', 'resolved', 'cancelled', 'declined', "won't do", 'wont do'];

  for (const history of changelog) {
    for (const item of history.items || []) {
      if (item.field === 'status') {
        statusTransitions.push({
          from: item.fromString,
          to: item.toString,
          when: history.created,
        });
        // True reopen = transition FROM a final/resolved status TO a non-final status
        const fromLower = (item.fromString || '').toLowerCase();
        const toLower = (item.toString || '').toLowerCase();
        if (FINAL_STATUSES.includes(fromLower) && !FINAL_STATUSES.includes(toLower)) {
          reopenCount++;
          lastReopened = history.created;
          reopenTimestamps.push(new Date(history.created));
        }
      }
      if (item.field === 'assignee') {
        assigneeChanges++;
      }
    }
  }

  // 72-hour reopen window for chronic reopen detection
  const now = new Date();
  const seventyTwoHoursAgo = new Date(now - 72 * 3600000);
  const reopensIn72h = reopenTimestamps.filter(ts => ts >= seventyTwoHoursAgo).length;
  const isChronicReopen = reopensIn72h >= 4;

  // SLA: First external reply time
  const firstExternalComment = comments.find(c => !c.isInternal);
  const firstReplyTime = firstExternalComment ? new Date(firstExternalComment.created) : null;
  const ticketCreated = f.created ? new Date(f.created) : null;
  const hoursToFirstReply = (ticketCreated && firstReplyTime)
    ? (firstReplyTime - ticketCreated) / 3600000
    : null;

  // SLA thresholds: 120min (2h) for FHPS, 4h for all others
  const slaThresholdHours = projectKey === 'FHPS' ? 2 : 4;
  const isDone = (f.status?.statusCategory?.name || '').toLowerCase() === 'done';
  const slaBreach = hoursToFirstReply !== null
    ? hoursToFirstReply > slaThresholdHours
    : (!isDone && ticketCreated ? (Date.now() - ticketCreated.getTime()) / 3600000 > slaThresholdHours : false);
  const slaBreachPenalty = (slaBreach && projectKey === 'FHPS') ? 200 : 0;

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

  // Age since creation (distinct from hoursSinceUpdate)
  const hoursSinceCreation = ticketCreated ? (Date.now() - ticketCreated.getTime()) / 3600000 : null;

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
    partner: (f.customfield_10942 && f.customfield_10942.value) ? f.customfield_10942.value : ((f.components || [])[0]?.name || ''),
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
    reopenTimestamps: reopenTimestamps.map(ts => ts.toISOString()),
    reopensIn72h,
    isChronicReopen,
    assigneeChanges,
    statusTransitions,
    hoursSinceUpdate: hoursSinceUpdate ? Math.round(hoursSinceUpdate * 10) / 10 : null,
    hoursSinceActivity: hoursSinceActivity ? Math.round(hoursSinceActivity * 10) / 10 : null,
    hoursSinceCreation: hoursSinceCreation ? Math.round(hoursSinceCreation * 10) / 10 : null,
    cycleTimeHours: cycleTimeHours ? Math.round(cycleTimeHours * 10) / 10 : null,
    hoursToFirstReply: hoursToFirstReply ? Math.round(hoursToFirstReply * 10) / 10 : null,
    slaThresholdHours,
    slaBreach,
    slaBreachPenalty,
    firstReplyTime: firstReplyTime ? firstReplyTime.toISOString() : null,
    awaitingFirstReply: !firstExternalComment && !isDone,
    highCommentVolume: comments.length > 6,
    isStagnant: hoursSinceUpdate !== null && hoursSinceUpdate > 24,
    isReopened: reopenCount > 0,
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
        data = await getHistory(event.queryStringParameters || {});
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
