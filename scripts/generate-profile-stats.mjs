import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.GITHUB_USERNAME || "C0qUX";
const OUT_DIR = path.resolve("assets/stats");
const TOKEN =
  process.env.PROFILE_STATS_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;
const HAS_PROFILE_TOKEN = Boolean(process.env.PROFILE_STATS_TOKEN);
const TOKEN_SOURCE = process.env.PROFILE_STATS_TOKEN
  ? "PROFILE_STATS_TOKEN"
  : process.env.GH_TOKEN
    ? "GH_TOKEN"
    : "GITHUB_TOKEN";
const REQUIRE_PROFILE_TOKEN =
  process.env.REQUIRE_PROFILE_STATS_TOKEN === "true";

if (REQUIRE_PROFILE_TOKEN && !HAS_PROFILE_TOKEN) {
  throw new Error(
    "Missing PROFILE_STATS_TOKEN. Add a personal access token as an Actions secret so private/token-visible stats stay accurate."
  );
}

if (!TOKEN) {
  throw new Error(
    "Missing GitHub token. Set PROFILE_STATS_TOKEN or GITHUB_TOKEN."
  );
}

const COLORS = {
  bg: "#0D1117",
  border: "#30363D",
  title: "#38BDF8",
  accent: "#A78BFA",
  text: "#C9D1D9",
  muted: "#8B949E",
  grid: "#21262D",
  empty: "#161B22",
};

const apiHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${USERNAME}-profile-stats`,
};

async function rest(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: apiHeaders,
  });

  if (!response.ok) {
    throw new Error(
      `GitHub REST request failed: ${response.status} ${response.statusText} ${pathname}`
    );
  }

  return response.json();
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...apiHeaders,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok || json.errors) {
    throw new Error(
      `GitHub GraphQL request failed: ${JSON.stringify(
        json.errors || json,
        null,
        2
      )}`
    );
  }

  return json.data;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDateRange(start, end) {
  if (!start || !end) return "";
  const fmt = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${fmt.format(new Date(`${start}T00:00:00Z`))} - ${fmt.format(
    new Date(`${end}T00:00:00Z`)
  )}`;
}

function flattenDays(calendar) {
  return calendar.weeks.flatMap((week) => week.contributionDays);
}

function getStreaks(days) {
  let longest = { count: 0, start: null, end: null };
  let active = { count: 0, start: null, end: null };

  for (const day of days) {
    if (day.contributionCount > 0) {
      active.count += 1;
      active.start ||= day.date;
      active.end = day.date;
    } else {
      if (active.count > longest.count) longest = { ...active };
      active = { count: 0, start: null, end: null };
    }
  }

  if (active.count > longest.count) longest = { ...active };

  let current = { count: 0, start: null, end: null };
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day.contributionCount === 0) break;
    current.count += 1;
    current.start = day.date;
    current.end ||= day.date;
  }

  return { current, longest };
}

async function searchTotal(query) {
  const params = new URLSearchParams({ q: query, per_page: "1" });
  const json = await rest(`/search/issues?${params}`);
  return json.total_count;
}

async function searchCommitTotal() {
  const search = async (query) => {
    const params = new URLSearchParams({
      q: query,
      per_page: "1",
    });
    return rest(`/search/commits?${params}`);
  };

  const allTime = await search(`author:${USERNAME}`);
  if (!allTime.incomplete_results) {
    return allTime.total_count;
  }

  let total = 0;
  const currentYear = new Date().getUTCFullYear();
  for (let year = 2008; year <= currentYear; year += 1) {
    const yearly = await search(
      `author:${USERNAME} author-date:${year}-01-01..${year}-12-31`
    );

    if (yearly.incomplete_results) {
      throw new Error(
        `GitHub commit search returned incomplete results for ${year}.`
      );
    }

    total += yearly.total_count;
  }

  return total;
}

async function getProfileData() {
  const [commits, prs, issues, profile] = await Promise.all([
    searchCommitTotal(),
    searchTotal(`author:${USERNAME} type:pr`),
    searchTotal(`author:${USERNAME} type:issue`),
    graphql(
      `
        query Profile($login: String!) {
          user(login: $login) {
            contributionsCollection {
              restrictedContributionsCount
              totalCommitContributions
              totalIssueContributions
              totalPullRequestContributions
              totalRepositoryContributions
              totalRepositoriesWithContributedCommits
              contributionCalendar {
                totalContributions
                weeks {
                  contributionDays {
                    color
                    contributionCount
                    date
                    weekday
                  }
                }
              }
            }
          }
        }
      `,
      { login: USERNAME }
    ),
  ]);

  return {
    commits,
    prs,
    issues,
    contributions: profile.user.contributionsCollection,
  };
}

async function getRepositories() {
  const repositories = [];
  let after = null;

  do {
    const data = await graphql(
      `
        query Repositories($login: String!, $after: String) {
          user(login: $login) {
            repositories(
              first: 100
              after: $after
              ownerAffiliations: OWNER
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                name
                isFork
                isPrivate
                stargazerCount
                languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                  edges {
                    size
                    node {
                      name
                      color
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { login: USERNAME, after }
    );

    const connection = data.user.repositories;
    repositories.push(...connection.nodes.filter((repo) => !repo.isFork));
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return repositories;
}

function getLanguageTotals(repositories) {
  const totals = new Map();

  for (const repo of repositories) {
    for (const edge of repo.languages.edges) {
      const previous = totals.get(edge.node.name) || {
        name: edge.node.name,
        color: edge.node.color || COLORS.accent,
        size: 0,
      };
      previous.size += edge.size;
      totals.set(edge.node.name, previous);
    }
  }

  return [...totals.values()].sort((a, b) => b.size - a.size);
}

function statsSvg({ stars, commits, prs, issues, contributions }) {
  const totalContributions =
    contributions.contributionCalendar.totalContributions;
  const privateCount = contributions.restrictedContributionsCount;
  const scope =
    TOKEN_SOURCE === "GITHUB_TOKEN"
      ? "Workflow token scope"
      : "Token-visible scope";

  const rows = [
    ["Total Stars Earned", stars],
    ["Total Commits", commits],
    ["Total PRs", prs],
    ["Total Issues", issues],
    ["Contributions (last year)", totalContributions],
    ["Private/Restricted", privateCount],
  ];

  const rowText = rows
    .map(
      ([label, value], index) => `
        <text x="44" y="${65 + index * 18}" class="label">${escapeXml(
          label
        )}:</text>
        <text x="292" y="${65 + index * 18}" class="value">${compactNumber(
          value
        )}</text>
        <circle cx="26" cy="${61 + index * 18}" r="4" fill="${
          index % 2 === 0 ? COLORS.accent : COLORS.title
        }"/>`
    )
    .join("");

  return `
<svg width="400" height="165" viewBox="0 0 400 165" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(USERNAME)} GitHub Stats</title>
  <desc id="desc">Profile statistics generated from the GitHub API.</desc>
  <style>
    .title { fill: ${COLORS.title}; font: 600 14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .label { fill: ${COLORS.text}; font: 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .value { fill: ${COLORS.text}; font: 600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: end; }
    .scope { fill: ${COLORS.muted}; font: 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .live { fill: ${COLORS.title}; font: 700 18px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
  </style>
  <rect x="0.5" y="0.5" width="399" height="164" rx="4" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <text x="24" y="30" class="title">${escapeXml(USERNAME)}'s GitHub Stats</text>
  ${rowText}
  <circle cx="350" cy="82" r="35" stroke="${COLORS.grid}" stroke-width="5"/>
  <path d="M350 47a35 35 0 1 1-29.7 16.5" stroke="${COLORS.title}" stroke-width="5" stroke-linecap="round"/>
  <text x="350" y="88" class="live">API</text>
  <text x="350" y="118" class="scope" text-anchor="middle">${escapeXml(scope)}</text>
</svg>
`.trimStart();
}

function languagesSvg(languages) {
  const topLanguages = languages.slice(0, 6);
  const total = topLanguages.reduce((sum, language) => sum + language.size, 0);
  let offset = 0;

  const segments = topLanguages
    .map((language) => {
      const width = total ? (language.size / total) * 280 : 0;
      const segment = `<rect x="${30 + offset}" y="56" width="${width.toFixed(
        2
      )}" height="8" fill="${language.color}" />`;
      offset += width;
      return segment;
    })
    .join("");

  const legend = topLanguages
    .map((language, index) => {
      const x = index % 2 === 0 ? 30 : 175;
      const y = 90 + Math.floor(index / 2) * 25;
      const percentage = total ? (language.size / total) * 100 : 0;
      return `
        <circle cx="${x}" cy="${y - 4}" r="5" fill="${language.color}"/>
        <text x="${x + 12}" y="${y}" class="legend">${escapeXml(
        language.name
      )} ${percentage.toFixed(2)}%</text>`;
    })
    .join("");

  return `
<svg width="400" height="165" viewBox="0 0 400 165" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Most Used Languages</title>
  <desc id="desc">Language percentages across visible owned repositories.</desc>
  <style>
    .title { fill: ${COLORS.title}; font: 600 14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .legend { fill: ${COLORS.text}; font: 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .note { fill: ${COLORS.muted}; font: 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
  </style>
  <rect x="0.5" y="0.5" width="399" height="164" rx="4" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <text x="30" y="34" class="title">Most Used Languages</text>
  <clipPath id="bar"><rect x="30" y="56" width="280" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">
    <rect x="30" y="56" width="280" height="8" fill="${COLORS.grid}"/>
    ${segments}
  </g>
  ${legend}
  <text x="30" y="150" class="note">Generated from token-visible repositories</text>
</svg>
`.trimStart();
}

function streakSvg(calendar) {
  const days = flattenDays(calendar);
  const streaks = getStreaks(days);
  const total = calendar.totalContributions;

  return `
<svg width="535" height="210" viewBox="0 0 535 210" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">GitHub Streak</title>
  <desc id="desc">Current and longest contribution streaks from GitHub contribution calendar.</desc>
  <style>
    .num { fill: ${COLORS.text}; font: 700 24px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .label { fill: ${COLORS.text}; font: 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .accent { fill: ${COLORS.title}; font: 700 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .date { fill: ${COLORS.muted}; font: 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
  </style>
  <rect x="0.5" y="0.5" width="534" height="209" rx="4" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <line x1="172" y1="35" x2="172" y2="176" stroke="${COLORS.border}"/>
  <line x1="363" y1="35" x2="363" y2="176" stroke="${COLORS.border}"/>
  <text x="86" y="90" class="num">${compactNumber(total)}</text>
  <text x="86" y="122" class="label">Total Contributions</text>
  <text x="86" y="148" class="date">${formatDateRange(days[0]?.date, days.at(-1)?.date)}</text>
  <circle cx="267" cy="88" r="34" stroke="${COLORS.title}" stroke-width="4"/>
  <text x="267" y="94" class="num">${streaks.current.count}</text>
  <text x="267" y="126" class="accent">Current Streak</text>
  <text x="267" y="150" class="date">${formatDateRange(streaks.current.start, streaks.current.end)}</text>
  <text x="449" y="90" class="num">${streaks.longest.count}</text>
  <text x="449" y="122" class="label">Longest Streak</text>
  <text x="449" y="148" class="date">${formatDateRange(streaks.longest.start, streaks.longest.end)}</text>
</svg>
`.trimStart();
}

function contributionGraphSvg(calendar) {
  const weeks = calendar.weeks;
  const cell = 11;
  const gap = 3;
  const left = 48;
  const top = 32;
  const width = left + weeks.length * (cell + gap) + 18;
  const height = 132;

  const monthLabels = [];
  let lastMonth = "";
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const labelDay = weeks[weekIndex].contributionDays.find((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      return date.getUTCDate() <= 7;
    });
    if (!labelDay) continue;

    const month = new Date(`${labelDay.date}T00:00:00Z`).toLocaleString("en", {
      month: "short",
      timeZone: "UTC",
    });
    if (month !== lastMonth) {
      monthLabels.push(
        `<text x="${left + weekIndex * (cell + gap)}" y="18" class="month">${month}</text>`
      );
      lastMonth = month;
    }
  }

  const cells = weeks
    .map((week, weekIndex) =>
      week.contributionDays
        .map((day) => {
          const x = left + weekIndex * (cell + gap);
          const y = top + day.weekday * (cell + gap);
          const color = day.contributionCount ? day.color : COLORS.empty;
          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${color}"><title>${day.contributionCount} contributions on ${day.date}</title></rect>`;
        })
        .join("")
    )
    .join("");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Contribution Graph</title>
  <desc id="desc">${calendar.totalContributions} contributions in the last year.</desc>
  <style>
    .month, .weekday, .note { fill: ${COLORS.muted}; font: 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .total { fill: ${COLORS.text}; font: 600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
  </style>
  <rect width="${width}" height="${height}" rx="4" fill="${COLORS.bg}"/>
  <text x="${left}" y="116" class="total">${compactNumber(calendar.totalContributions)} contributions in the last year</text>
  ${monthLabels.join("")}
  <text x="14" y="${top + 1 * (cell + gap) + 9}" class="weekday">Mon</text>
  <text x="14" y="${top + 3 * (cell + gap) + 9}" class="weekday">Wed</text>
  <text x="14" y="${top + 5 * (cell + gap) + 9}" class="weekday">Fri</text>
  ${cells}
  <text x="${width - 150}" y="116" class="note">Less</text>
  <rect x="${width - 121}" y="107" width="10" height="10" rx="2" fill="${COLORS.empty}"/>
  <rect x="${width - 106}" y="107" width="10" height="10" rx="2" fill="#0E4429"/>
  <rect x="${width - 91}" y="107" width="10" height="10" rx="2" fill="#006D32"/>
  <rect x="${width - 76}" y="107" width="10" height="10" rx="2" fill="#26A641"/>
  <rect x="${width - 61}" y="107" width="10" height="10" rx="2" fill="#39D353"/>
  <text x="${width - 46}" y="116" class="note">More</text>
</svg>
`.trimStart();
}

async function main() {
  const [profile, repositories] = await Promise.all([
    getProfileData(),
    getRepositories(),
  ]);

  const stars = repositories.reduce((sum, repo) => sum + repo.stargazerCount, 0);
  const languages = getLanguageTotals(repositories);
  const calendar = profile.contributions.contributionCalendar;

  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(OUT_DIR, "github-stats.svg"),
      statsSvg({ stars, ...profile }),
      "utf8"
    ),
    writeFile(path.join(OUT_DIR, "top-langs.svg"), languagesSvg(languages), "utf8"),
    writeFile(path.join(OUT_DIR, "github-streak.svg"), streakSvg(calendar), "utf8"),
    writeFile(
      path.join(OUT_DIR, "contribution-graph.svg"),
      contributionGraphSvg(calendar),
      "utf8"
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        username: USERNAME,
        tokenScope: TOKEN_SOURCE,
        commits: profile.commits,
        prs: profile.prs,
        issues: profile.issues,
        stars,
        contributionsLastYear: calendar.totalContributions,
        privateOrRestricted: profile.contributions.restrictedContributionsCount,
        repositories: repositories.length,
        languages: languages.slice(0, 6).map((language) => language.name),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
