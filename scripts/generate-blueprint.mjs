// Renders transparent dark and light SVGs from live GitHub data.
// Usage: GH_TOKEN=<token> node scripts/generate-blueprint.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const config = {
  login: "Cyneric",
  // Languages that should not show up in "Most used languages", e.g. "HTML".
  excludeLanguages: [],
  // Repositories (name only) whose code is ignored for the language stats.
  excludeRepos: [],
  // Number of languages shown before the rest is grouped as "Other".
  topLanguages: 5,
};

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GH_TOKEN or GITHUB_TOKEN is not set.");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(root, "assets/blueprint.svg");

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cyneric-blueprint",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GitHub API error: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function fetchCalendar() {
  const data = await graphql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        contributionsCollection {
          contributionYears
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount contributionLevel } }
          }
        }
      }
    }`,
    { login: config.login },
  );
  return data.user;
}

// The API returns at most one year per contributionsCollection, so all years
// are requested as aliases in a single query. Days after today are dropped,
// the current year's calendar runs until December 31.
async function fetchHistory(years) {
  const fields = years
    .map(
      (y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }`,
    )
    .join("\n");
  const data = await graphql(`query($login: String!) { user(login: $login) { ${fields} } }`, {
    login: config.login,
  });
  const today = new Date().toISOString().slice(0, 10);
  const perYear = years
    .map((year) => ({ year, total: data.user[`y${year}`].contributionCalendar.totalContributions }))
    .sort((a, b) => a.year - b.year);
  const days = Object.values(data.user)
    .flatMap((c) => c.contributionCalendar.weeks.flatMap((w) => w.contributionDays))
    .filter((d) => d.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { perYear, days };
}

async function fetchRepoStats() {
  const totals = new Map();
  let stars = 0;
  let cursor = null;
  do {
    const data = await graphql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              stargazerCount
              languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name } }
              }
            }
          }
        }
      }`,
      { login: config.login, cursor },
    );
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      stars += repo.stargazerCount;
      if (config.excludeRepos.includes(repo.name)) continue;
      for (const { size, node } of repo.languages.edges) {
        if (config.excludeLanguages.includes(node.name)) continue;
        totals.set(node.name, (totals.get(node.name) ?? 0) + size);
      }
    }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (cursor);

  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, config.topLanguages).map(([name, size]) => ({ name, share: size / sum }));
  const rest = sorted.slice(config.topLanguages).reduce((a, [, size]) => a + size, 0);
  if (rest > 0) top.push({ name: "Other", share: rest / sum });
  return { langs: top, stars };
}

function longestStreak(days) {
  let best = 0, run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// Consecutive days with contributions, ending today. A day without
// contributions yet does not break the streak until it is over.
function currentStreak(days) {
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  let streak = 0;
  while (i >= 0 && days[i].contributionCount > 0) {
    streak++;
    i--;
  }
  return streak;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (n) => n.toLocaleString("en-US");

const LEVEL_OPACITY = {
  NONE: 0,
  FIRST_QUARTILE: 0.25,
  SECOND_QUARTILE: 0.45,
  THIRD_QUARTILE: 0.7,
  FOURTH_QUARTILE: 1,
};
const HATCHES = ["h1", "h2", "h3", "h4", "h5", "h6"];

function renderHeader(rev) {
  return `
  <text class="mono" x="10" y="22" font-size="11" opacity=".7">DWG NO. CB-001 · REV. ${rev}</text>
  <text class="sans" x="10" y="52" font-size="26" font-weight="700">CHRISTIAN BLANK</text>
  <text class="mono" x="10" y="72" font-size="12">SENIOR SOFTWARE ENGINEER · GERMANY</text>
  <g fill="none" stroke="#e9f3ff" stroke-width="1.4">
    <rect x="20" y="110" width="150" height="70" rx="4"/>
    <rect x="255" y="110" width="150" height="70" rx="4"/>
    <rect x="490" y="110" width="150" height="70" rx="4"/>
    <rect x="255" y="215" width="150" height="46" rx="4" stroke-dasharray="5 4"/>
    <path class="wire" pathLength="1" d="M170 145H253" marker-end="url(#ar)"/>
    <path class="wire" pathLength="1" d="M405 145H488" marker-end="url(#ar)"/>
    <path class="wire" pathLength="1" d="M330 180V213" marker-end="url(#ar)"/>
    <path class="signal" pathLength="1" d="M170 145H253"/>
    <path class="signal signal-two" pathLength="1" d="M405 145H488"/>
    <path class="signal signal-three" pathLength="1" d="M330 180V213"/>
    <line x1="22" y1="95" x2="638" y2="95" stroke-width=".6" marker-start="url(#al)" marker-end="url(#ar)"/>
  </g>
  <g class="mono" text-anchor="middle">
    <text x="330" y="91" font-size="9" opacity=".8">FULL STACK · SCALE 1:1</text>
    <text x="95" y="132" font-size="11" font-weight="700">CLIENT</text>
    <text x="95" y="150" font-size="9">React · Next.js</text>
    <text x="95" y="164" font-size="9">Angular · Tailwind</text>
    <text x="330" y="132" font-size="11" font-weight="700">SERVICES</text>
    <text x="330" y="150" font-size="9">.NET · Node · Laravel</text>
    <text x="330" y="164" font-size="9">TypeScript · C#</text>
    <text x="565" y="132" font-size="11" font-weight="700">DATA</text>
    <text x="565" y="150" font-size="9">Postgres · Redis</text>
    <text x="565" y="164" font-size="9">Mongo · SQLite</text>
    <text x="330" y="235" font-size="10" font-weight="700">INFRA</text>
    <text x="330" y="250" font-size="9">Docker · Ansible · Nginx</text>
  </g>`;
}

function renderCalendar(weeks) {
  const x0 = 40, y0 = 30, cell = 11, size = 8.5;
  let cells = "";
  weeks.forEach((week, x) => {
    for (const day of week.contributionDays) {
      const y = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      cells += `<rect x="${x0 + x * cell}" y="${y0 + y * cell}" width="${size}" height="${size}" rx="1" fill-opacity="${LEVEL_OPACITY[day.contributionLevel]}"/>`;
    }
  });
  const xe = x0 + (weeks.length - 1) * cell + size;
  const ye = y0 + 6 * cell + size;
  return `
  <text class="mono" x="10" y="14" font-size="9" opacity=".7">DETAIL A · CONTRIBUTION GRAPH</text>
  <g fill="#e9f3ff" stroke="#e9f3ff" stroke-opacity=".35" stroke-width=".6">${cells}</g>
  <g fill="none" stroke="#e9f3ff" stroke-width=".6">
    <line x1="${x0}" y1="${ye + 10}" x2="${xe}" y2="${ye + 10}" marker-start="url(#al)" marker-end="url(#ar)"/>
    <line x1="${x0 - 12}" y1="${y0}" x2="${x0 - 12}" y2="${ye}" marker-start="url(#al)" marker-end="url(#ar)"/>
  </g>
  <text class="mono" x="${(x0 + xe) / 2}" y="${ye + 22}" font-size="9" text-anchor="middle">LAST 365 DAYS</text>
  <text class="mono" x="${x0 - 16}" y="${(y0 + ye) / 2 + 3}" font-size="9" text-anchor="end">7d</text>`;
}

// Labels sit at evenly spaced slots and connect to their segment with an
// elbow leader, so narrow segments never make labels overlap.
function renderLanguages(langs) {
  const x0 = 40, width = 580, y = 34, h = 22;
  const rounded = langs.map((l) => Math.round(l.share * 100));
  let x = x0, out = "";
  langs.forEach((lang, i) => {
    const w = width * lang.share;
    const cx = x + w / 2;
    const lx = x0 + (width * (i + 0.5)) / langs.length;
    const ly = y + h + 34;
    out += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" fill="url(#${HATCHES[i]})" stroke="#e9f3ff"/>`;
    out += `<polyline points="${cx.toFixed(1)},${y + h} ${cx.toFixed(1)},${y + h + 8} ${lx.toFixed(1)},${y + h + 18} ${lx.toFixed(1)},${ly - 10}" fill="none" stroke="#e9f3ff" stroke-width=".6"/>`;
    out += `<circle cx="${cx.toFixed(1)}" cy="${y + h}" r="1.6" fill="#e9f3ff"/>`;
    out += `<text class="mono" x="${lx.toFixed(1)}" y="${ly}" font-size="9" text-anchor="middle">${esc(lang.name.toUpperCase())} ${rounded[i]}%</text>`;
    x += w;
  });
  return `
  <text class="mono" x="10" y="14" font-size="9" opacity=".7">DETAIL B · MOST USED LANGUAGES</text>
  ${out}
  <line x1="${x0}" y1="${y - 8}" x2="${x0 + width}" y2="${y - 8}" stroke="#e9f3ff" stroke-width=".6" marker-start="url(#al)" marker-end="url(#ar)"/>
  <text class="mono" x="${x0 + width / 2}" y="${y - 11}" font-size="8" text-anchor="middle" opacity=".8">100% · BY BYTES OF CODE</text>`;
}

// Linear scale on purpose: early years stay tiny, which is the point.
function renderYears(perYear) {
  const x0 = 40, width = 580, base = 118, maxH = 80;
  const max = Math.max(...perYear.map((y) => y.total), 1);
  const slot = width / perYear.length;
  const bw = slot * 0.6;
  const current = new Date().getUTCFullYear();
  const bars = perYear
    .map(({ year, total }, i) => {
      const h = Math.max((total / max) * maxH, total > 0 ? 1 : 0);
      const x = x0 + i * slot + (slot - bw) / 2;
      const cx = x + bw / 2;
      const dash = year === current ? ` stroke-dasharray="3 2"` : "";
      return `<rect class="year-bar" style="animation-delay: ${(0.6 + i * 0.035).toFixed(3)}s" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="url(#h2)" stroke="#e9f3ff"${dash}/>
    <text class="mono" x="${cx.toFixed(1)}" y="${(base - h - 4).toFixed(1)}" font-size="8" text-anchor="middle">${num(total)}</text>
    <text class="mono" x="${cx.toFixed(1)}" y="${base + 12}" font-size="8" text-anchor="middle" opacity=".8">${year}</text>`;
    })
    .join("\n    ");
  return `
  <text class="mono" x="10" y="14" font-size="9" opacity=".7">DETAIL C · CONTRIBUTIONS PER YEAR</text>
    ${bars}
  <line x1="${x0}" y1="${base}" x2="${x0 + width}" y2="${base}" stroke="#e9f3ff" stroke-width="1"/>
  <line x1="${x0}" y1="${base + 22}" x2="${x0 + width}" y2="${base + 22}" stroke="#e9f3ff" stroke-width=".6" marker-start="url(#al)" marker-end="url(#ar)"/>
  <text class="mono" x="${x0 + width / 2}" y="${base + 34}" font-size="9" text-anchor="middle">${perYear[0].year} TO ${current} · DASHED ${current} = YEAR TO DATE</text>`;
}

const days = (n) => `${num(n)} ${n === 1 ? "day" : "days"}`;
const monthYear = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function renderTitleBlock(stats) {
  const cells = [
    ["FIELD", "Biotechnology", false],
    ["DOMAIN", "Laboratory Analytical Instruments", false],
    ["LOCATION", "Germany", false],
    ["TOTAL CONTRIBUTIONS", num(stats.total), true],
    ["CURRENT STREAK", days(stats.streak), true],
    ["LAST 365 DAYS", num(stats.lastYear), true],
    ["ON GITHUB SINCE", monthYear(stats.createdAt), true],
    ["LONGEST STREAK", days(stats.longestStreak), true],
    ["STARS / FOLLOWERS", `${num(stats.stars)} / ${num(stats.followers)}`, true],
  ];
  const w = 220, h = 40;
  const out = cells
    .map(([label, value, big], i) => {
      const x = (i % 3) * w, y = Math.floor(i / 3) * h;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e9f3ff" stroke-opacity=".65" stroke-width=".5"/>
    <text class="mono" x="${x + 8}" y="${y + 13}" font-size="7.5" opacity=".65" letter-spacing="1">${label}</text>
    <text class="mono" x="${x + 8}" y="${y + 31}" font-size="${big ? 14 : 10}" font-weight="${big ? 700 : 400}">${esc(value)}</text>`;
    })
    .join("\n    ");
  return `${out}
    <rect x="0" y="0" width="${w * 3}" height="${h * (cells.length / 3)}" fill="none" stroke="#e9f3ff" stroke-width="1.5"/>`;
}

function renderSvg({ weeks, langs, perYear, stats, updated }) {
  const W = 700, H = 860;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">
  <title id="title">Christian Blank · Senior Software Engineer</title>
  <desc id="desc">Senior Software Engineer from Germany, currently working in the field of Biotechnology: Laboratory Analytical Instruments. ${num(stats.total)} total contributions, ${num(stats.lastYear)} in the last 365 days, current streak ${stats.streak} days.</desc>
  <style>
    text { fill: #e9f3ff; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; }
    .sans { font-family: "Segoe UI", -apple-system, Helvetica, Arial, sans-serif; }
    .wire {
      stroke-dasharray: 1;
      stroke-dashoffset: 0;
      animation: draw 1.4s .25s both;
    }
    .year-bar {
      transform-box: fill-box;
      transform-origin: center bottom;
      animation: grow 1.1s ease-out both;
    }
    .signal {
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: .045 .955;
      stroke-dashoffset: 1;
      opacity: 0;
      animation: signal 6s 1.8s linear infinite;
    }
    .signal-two { animation-delay: 2.7s; }
    .signal-three { animation-delay: 3.1s; }
    @keyframes draw {
      from { stroke-dashoffset: 1; }
      to { stroke-dashoffset: 0; }
    }
    @keyframes grow {
      from { transform: scaleY(0); }
      to { transform: scaleY(1); }
    }
    @keyframes signal {
      0% { stroke-dashoffset: 1; opacity: 0; }
      8% { opacity: .85; }
      60% { stroke-dashoffset: 0; opacity: .85; }
      66%, 100% { stroke-dashoffset: 0; opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .wire, .year-bar, .signal { animation: none; }
      .signal { display: none; }
    }
  </style>
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#e9f3ff"/></marker>
    <marker id="al" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M10 0L0 5L10 10z" fill="#e9f3ff"/></marker>
    <pattern id="gridMinor" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#ffffff" stroke-opacity=".03"/></pattern>
    <pattern id="gridMajor" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="#ffffff" stroke-opacity=".08"/></pattern>
    <pattern id="h1" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#e9f3ff" fill-opacity=".85"/></pattern>
    <pattern id="h2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#e9f3ff" stroke-width="2.4"/></pattern>
    <pattern id="h3" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#e9f3ff" stroke-width="1.2"/></pattern>
    <pattern id="h4" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 3H6M3 0V6" stroke="#e9f3ff" stroke-width="1"/></pattern>
    <pattern id="h5" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1" fill="#e9f3ff"/></pattern>
    <pattern id="h6" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="none"/></pattern>
  </defs>
  <rect width="${W}" height="${H}" rx="10" fill="url(#gridMinor)"/>
  <rect width="${W}" height="${H}" rx="10" fill="url(#gridMajor)"/>
  <g transform="translate(20 20)">${renderHeader(updated.slice(0, 4))}
  </g>
  <g transform="translate(20 300)">${renderCalendar(weeks)}
  </g>
  <g transform="translate(20 425)">${renderLanguages(langs)}
  </g>
  <g transform="translate(20 535)">${renderYears(perYear)}
  </g>
  <g transform="translate(20 700)">
    ${renderTitleBlock(stats)}
  </g>
  <text class="mono" x="${W - 20}" y="${H - 22}" font-size="7.5" text-anchor="end" opacity=".5">UPDATED ${updated}</text>
</svg>
`;
}

const user = await fetchCalendar();
const calendar = user.contributionsCollection.contributionCalendar;
const [history, repoStats] = await Promise.all([
  fetchHistory(user.contributionsCollection.contributionYears),
  fetchRepoStats(),
]);
const { langs } = repoStats;
const stats = {
  total: history.perYear.reduce((sum, y) => sum + y.total, 0),
  lastYear: calendar.totalContributions,
  streak: currentStreak(history.days),
  longestStreak: longestStreak(history.days),
  createdAt: user.createdAt,
  stars: repoStats.stars,
  followers: user.followers.totalCount,
};
const updated = new Date().toISOString().slice(0, 10);

await mkdir(dirname(outFile), { recursive: true });
const darkSvg = renderSvg({ weeks: calendar.weeks, langs, perYear: history.perYear, stats, updated });
const lightSvg = darkSvg.replaceAll("#e9f3ff", "#1f2328").replaceAll("#ffffff", "#1f2328");
// Some browsers do not pass reduced-motion preferences into SVG images.
// The README selects these static versions at the picture level as well.
const staticSvg = (svg) => svg.replace("</style>", `
    .wire, .year-bar, .signal { animation: none; }
    .signal { display: none; }
  </style>`);
await Promise.all([
  writeFile(outFile, darkSvg),
  writeFile(resolve(root, "assets/blueprint-light.svg"), lightSvg),
  writeFile(resolve(root, "assets/blueprint-static.svg"), staticSvg(darkSvg)),
  writeFile(resolve(root, "assets/blueprint-light-static.svg"), staticSvg(lightSvg)),
]);
console.log(`Wrote ${outFile}`, { ...stats, languages: langs.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`) });
