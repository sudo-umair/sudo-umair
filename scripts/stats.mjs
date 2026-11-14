import { writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const login = process.env.GH_USER ?? "sudo-umair";
if (!token) throw new Error("GITHUB_TOKEN is required");

const THEMES = {
  light: { fg: "#0b0b0c", muted: "#5b5d66", line: "#d9dae0", accent: "#2337ff" },
  dark: { fg: "#ededf0", muted: "#9a9ca6", line: "#2a2c33", accent: "#7d8bff" },
};

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-stats" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

async function fetchOverview() {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionYears
          totalCommitContributions
          totalPullRequestContributions
          contributionCalendar { totalContributions }
        }
      }
    }`,
    { login },
  );
  return data.user.contributionsCollection;
}

async function fetchRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
            }
          }
        }
      }`,
      { login, after },
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function fetchDays(years) {
  const fields = years
    .map(
      (y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
        contributionCalendar { weeks { contributionDays { date contributionCount } } }
      }`,
    )
    .join("\n");
  const data = await gql(`query($login: String!) { user(login: $login) { ${fields} } }`, { login });
  return Object.values(data.user)
    .flatMap((c) => c.contributionCalendar.weeks.flatMap((w) => w.contributionDays))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function streaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  const past = days.filter((d) => d.date <= today);
  let longest = 0;
  let run = 0;
  for (const d of past) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let i = past.length - 1;
  if (past[i]?.date === today && past[i].contributionCount === 0) i--;
  let current = 0;
  while (i >= 0 && past[i].contributionCount > 0) {
    current++;
    i--;
  }
  return { current, longest };
}

function topLanguages(repos, count = 6) {
  const totals = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) totals.set(node.name, (totals.get(node.name) ?? 0) + size);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, count).map(([name, size]) => ({ name, pct: (size / sum) * 100 }));
  const rest = 100 - top.reduce((a, l) => a + l.pct, 0);
  if (sorted.length > count && rest >= 0.5) top.push({ name: "Other", pct: rest });
  return top;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : n.toLocaleString("en-US"));
const shade = (i, n) => (1 - (i / Math.max(n - 1, 1)) * 0.7).toFixed(2);

const STYLE = `<style>
    .sans { font-family: 'Archivo', 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace; }
  </style>`;

function metricsSvg(metrics, t, { x0, y0, cols, colW, rowH, numSize, labelSize }) {
  return metrics
    .map((m, i) => {
      const x = x0 + (i % cols) * colW;
      const y = y0 + Math.floor(i / cols) * rowH;
      const unit = m.unit ? `<tspan font-size="${numSize * 0.4}" font-weight="400" fill="${t.muted}" dx="6">${m.unit}</tspan>` : "";
      return `<text class="sans" x="${x}" y="${y}" font-size="${numSize}" font-weight="800" letter-spacing="-1.5" fill="${t.fg}">${fmt(m.value)}${unit}</text>
  <text class="mono" x="${x}" y="${y + labelSize + 14}" font-size="${labelSize}" letter-spacing="1.5" fill="${t.muted}">${m.label}</text>`;
    })
    .join("\n  ");
}

function languagesSvg(langs, t, { x0, y0, width, legendCols, legendRowH, nameSize }) {
  let x = x0;
  const segments = langs
    .map((l, i) => {
      const w = Math.max((l.pct / 100) * width, 0);
      const seg = `<rect x="${x.toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="14" fill="${t.accent}" fill-opacity="${shade(i, langs.length)}"/>`;
      x += w;
      return seg;
    })
    .join("");
  const colW = width / legendCols;
  const legend = langs
    .map((l, i) => {
      const lx = x0 + (i % legendCols) * colW;
      const ly = y0 + nameSize * 2 + Math.floor(i / legendCols) * legendRowH;
      return `<circle cx="${lx + 6}" cy="${ly - nameSize * 0.35}" r="6" fill="${t.accent}" fill-opacity="${shade(i, langs.length)}"/>
  <text class="sans" x="${lx + 20}" y="${ly}" font-size="${nameSize}" fill="${t.fg}">${esc(l.name)} <tspan class="mono" font-size="${nameSize * 0.8}" fill="${t.muted}">${l.pct.toFixed(1)}%</tspan></text>`;
    })
    .join("\n  ");
  return `<clipPath id="bar"><rect x="${x0}" y="${y0}" width="${width}" height="14" rx="7"/></clipPath>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}`;
}

function wideCard(metrics, langs, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="330" viewBox="0 0 1200 330" role="img" aria-label="GitHub stats for ${login}">
  ${STYLE}
  <text class="mono" x="40" y="40" font-size="15" letter-spacing="2" fill="${t.muted}">GITHUB ACTIVITY</text>
  <text class="mono" x="680" y="40" font-size="15" letter-spacing="2" fill="${t.muted}">TOP LANGUAGES</text>
  <line x1="40" y1="60" x2="1160" y2="60" stroke="${t.fg}" stroke-width="2"/>
  <line x1="640" y1="90" x2="640" y2="300" stroke="${t.line}" stroke-width="1"/>
  ${metricsSvg(metrics, t, { x0: 40, y0: 150, cols: 3, colW: 200, rowH: 120, numSize: 52, labelSize: 14 })}
  ${languagesSvg(langs, t, { x0: 680, y0: 100, width: 480, legendCols: 2, legendRowH: 46, nameSize: 22 })}
</svg>
`;
}

function narrowCard(metrics, langs, t) {
  const legendRows = Math.ceil(langs.length / 2);
  const height = 614 + legendRows * 56;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${height}" viewBox="0 0 600 ${height}" role="img" aria-label="GitHub stats for ${login}">
  ${STYLE}
  <text class="mono" x="20" y="40" font-size="18" letter-spacing="1.5" fill="${t.muted}">GITHUB ACTIVITY</text>
  <line x1="20" y1="60" x2="580" y2="60" stroke="${t.fg}" stroke-width="2"/>
  ${metricsSvg(metrics, t, { x0: 20, y0: 150, cols: 2, colW: 290, rowH: 140, numSize: 72, labelSize: 20 })}
  <text class="mono" x="20" y="530" font-size="18" letter-spacing="1.5" fill="${t.muted}">TOP LANGUAGES</text>
  <line x1="20" y1="550" x2="580" y2="550" stroke="${t.fg}" stroke-width="2"/>
  ${languagesSvg(langs, t, { x0: 20, y0: 576, width: 560, legendCols: 2, legendRowH: 56, nameSize: 30 })}
</svg>
`;
}

const overview = await fetchOverview();
const [repos, days] = await Promise.all([fetchRepos(), fetchDays(overview.contributionYears)]);
const { current, longest } = streaks(days);
const metrics = [
  { label: "CONTRIBUTIONS / 1Y", value: overview.contributionCalendar.totalContributions },
  { label: "COMMITS / 1Y", value: overview.totalCommitContributions },
  { label: "PULL REQUESTS / 1Y", value: overview.totalPullRequestContributions },
  { label: "CURRENT STREAK", value: current, unit: "days" },
  { label: "LONGEST STREAK", value: longest, unit: "days" },
  { label: "REPOSITORIES", value: repos.length },
];
const langs = topLanguages(repos);

for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`assets/stats-${name}.svg`, wideCard(metrics, langs, t));
  await writeFile(`assets/stats-${name}-narrow.svg`, narrowCard(metrics, langs, t));
}
console.log(JSON.stringify({ metrics, langs }, null, 2));
