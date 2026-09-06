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

const CONTRIBUTION_COLORS = {
  0: COLORS.empty,
  1: "#0E4429",
  2: "#006D32",
  3: "#26A641",
  4: "#39D353",
};

const apiHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${USERNAME}-profile-stats`,
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function rateLimitDelay(headers, fallback) {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.max(1000, retryAfter * 1000);
  }

  const resetAt = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1000, resetAt * 1000 - Date.now() + 1000);
  }

  return fallback;
}

async function rest(pathname, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${pathname}`, {
        headers: apiHeaders,
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `GitHub REST network failure after ${maxAttempts} attempts on ${pathname}: ${error.message}`
        );
      }

      const delay = 5000 * attempt;
      console.warn(
        `GitHub REST network failure on ${pathname}; retrying in ${delay / 1000}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
      continue;
    }

    if (response.ok) return response.json();

    const body = await response.text();
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    const isRateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (remaining === "0" ||
          retryAfter ||
          body.toLowerCase().includes("rate limit")));
    const isTransient = isRateLimited || response.status >= 500;

    if (isTransient && attempt < maxAttempts) {
      const delay = isRateLimited
        ? rateLimitDelay(response.headers, 60000)
        : 5000 * attempt;
      console.warn(
        `GitHub REST temporary failure on ${pathname}; retrying in ${Math.ceil(delay / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts}, remaining=${remaining ?? "unknown"}).`
      );
      await sleep(delay);
      continue;
    }

    throw new Error(
      `GitHub REST request failed: ${response.status} ${response.statusText} ${pathname}; ` +
        `remaining=${remaining ?? "unknown"}; reset=${resetAt ?? "unknown"}; ` +
        `response=${body.slice(0, 500)}`
    );
  }

  throw new Error(`GitHub REST request failed after retries: ${pathname}`);
}

async function graphql(query, variables = {}, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          ...apiHeaders,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `GitHub GraphQL network failure after ${maxAttempts} attempts: ${error.message}`
        );
      }

      const delay = 5000 * attempt;
      console.warn(
        `GitHub GraphQL network failure; retrying in ${delay / 1000}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
      continue;
    }

    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Handled below as a transient non-JSON response.
    }

    if (response.ok && json?.data && !json.errors) return json.data;

    const details = json
      ? JSON.stringify(json.errors || json)
      : `Non-JSON response: ${body.slice(0, 500)}`;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    const isRateLimited =
      response.status === 429 ||
      remaining === "0" ||
      details.toLowerCase().includes("rate limit") ||
      (response.status === 403 && Boolean(retryAfter));
    const isTransient =
      isRateLimited ||
      response.status >= 500 ||
      !json ||
      /no server is currently available|please try again|timed? out|temporar/i.test(
        details
      );

    if (isTransient && attempt < maxAttempts) {
      const delay = isRateLimited
        ? rateLimitDelay(response.headers, 60000)
        : 5000 * attempt;
      console.warn(
        `GitHub GraphQL temporary failure; retrying in ${Math.ceil(delay / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
      continue;
    }

    throw new Error(
      `GitHub GraphQL request failed: ${details}; ` +
        `remaining=${remaining ?? "unknown"}; reset=${resetAt ?? "unknown"}`
    );
  }

  throw new Error("GitHub GraphQL request failed after retries.");
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
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const crossesYears = startDate.getUTCFullYear() !== endDate.getUTCFullYear();
  const fmt = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(crossesYears ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
  return `${fmt.format(startDate)} - ${fmt.format(endDate)}`;
}

function flattenDays(calendar) {
  return calendar.weeks.flatMap((week) => week.contributionDays);
}

function htmlAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

async function getPublicContributionCalendar(maxAttempts = 3) {
  // This is the same public calendar GitHub renders on the profile. It includes
  // anonymized private contributions when the user has chosen to display them.
  const url = `https://github.com/users/${encodeURIComponent(USERNAME)}/contributions`;
  let html = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html",
          "Accept-Language": "en",
          "User-Agent": `${USERNAME}-profile-stats`,
        },
        signal: AbortSignal.timeout(30000),
      });
      html = await response.text();

      if (response.ok) break;

      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          html.toLowerCase().includes("rate limit"));
      const isTransient = isRateLimited || response.status >= 500;

      if (!isTransient || attempt === maxAttempts) {
        throw new Error(
          `GitHub public contribution calendar failed: ${response.status} ` +
            `${response.statusText}; response=${html.slice(0, 300)}`
        );
      }

      const delay = isRateLimited
        ? rateLimitDelay(response.headers, 60000)
        : 5000 * attempt;
      console.warn(
        `GitHub public calendar temporary failure; retrying in ${Math.ceil(delay / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
    } catch (error) {
      if (attempt === maxAttempts || /calendar failed:/.test(error.message)) {
        throw error;
      }

      const delay = 5000 * attempt;
      console.warn(
        `GitHub public calendar network failure; retrying in ${delay / 1000}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
    }
  }

  const daysById = new Map();
  const dayTags = html.match(/<td\b[^>]*ContributionCalendar-day[^>]*>/g) || [];

  for (const tag of dayTags) {
    const id = htmlAttribute(tag, "id");
    const date = htmlAttribute(tag, "data-date");
    const level = Number(htmlAttribute(tag, "data-level"));
    if (!id || !date || !Number.isInteger(level)) continue;

    daysById.set(id, {
      color: CONTRIBUTION_COLORS[level] || CONTRIBUTION_COLORS[4],
      contributionCount: null,
      date,
      weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
    });
  }

  const tooltipPattern = /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g;
  for (const match of html.matchAll(tooltipPattern)) {
    const day = daysById.get(match[1]);
    if (!day) continue;

    const label = match[2].replace(/<[^>]+>/g, " ").trim();
    const count = label.match(/([\d,]+)\s+contributions?/i);
    if (count) {
      day.contributionCount = Number(count[1].replaceAll(",", ""));
    } else if (/^No contributions\b/i.test(label)) {
      day.contributionCount = 0;
    }
  }

  const days = [...daysById.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const hasCompleteDateRange = days.every((day, index) => {
    if (index === 0) return true;
    const previous = new Date(`${days[index - 1].date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() + 1);
    return previous.toISOString().slice(0, 10) === day.date;
  });
  if (
    days.length < 365 ||
    days.length > 371 ||
    !hasCompleteDateRange ||
    days.some((day) => day.contributionCount === null)
  ) {
    throw new Error(
      `Could not parse GitHub's public contribution calendar (${days.length} days found).`
    );
  }

  const totalContributions = days.reduce(
    (sum, day) => sum + day.contributionCount,
    0
  );
  const headingTotal = html
    .match(
      /id="js-contribution-activity-description"[\s\S]{0,300}?([\d,]+)\s+contributions?/i
    )?.[1]
    ?.replaceAll(",", "");

  if (!headingTotal) {
    throw new Error("Could not parse GitHub's public contribution total.");
  }

  if (Number(headingTotal) !== totalContributions) {
    throw new Error(
      `GitHub public contribution total mismatch: heading=${headingTotal}, days=${totalContributions}.`
    );
  }

  const weeksByStart = new Map();
  for (const day of days) {
    const weekStart = new Date(`${day.date}T00:00:00Z`);
    weekStart.setUTCDate(weekStart.getUTCDate() - day.weekday);
    const key = weekStart.toISOString().slice(0, 10);
    const week = weeksByStart.get(key) || { contributionDays: [] };
    week.contributionDays.push(day);
    weeksByStart.set(key, week);
  }

  return {
    totalContributions,
    weeks: [...weeksByStart.values()],
  };
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

async function completeCommitSearch(search, query, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await search(query);
    if (!result.incomplete_results) return result;

    if (attempt < maxAttempts) {
      const delay = 2000 * 2 ** (attempt - 1);
      console.warn(
        `GitHub commit search was incomplete; retrying in ${delay / 1000}s ` +
          `(attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
    }
  }

  return null;
}

async function searchCommitTotal(accountCreatedAt) {
  const search = async (query) => {
    const params = new URLSearchParams({
      q: query,
      per_page: "1",
    });
    return rest(`/search/commits?${params}`);
  };

  const allTime = await completeCommitSearch(search, `author:${USERNAME}`);
  if (allTime) {
    return allTime.total_count;
  }

  let total = 0;
  const firstYear = new Date(accountCreatedAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  for (let year = firstYear; year <= currentYear; year += 1) {
    const yearly = await completeCommitSearch(
      search,
      `author:${USERNAME} author-date:${year}-01-01..${year}-12-31`
    );

    if (!yearly) {
      throw new Error(
        `GitHub commit search stayed incomplete for ${year} after retries.`
      );
    }

    total += yearly.total_count;
  }

  return total;
}

async function getProfileData() {
  const profile = await graphql(
    `
        query Profile($login: String!) {
          viewer {
            login
          }
          user(login: $login) {
            createdAt
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
  );

  if (profile.viewer.login.toLowerCase() !== USERNAME.toLowerCase()) {
    console.warn(
      `PROFILE_STATS_TOKEN belongs to ${profile.viewer.login}, not ${USERNAME}.`
    );
  }

  const tokenCalendar = profile.user.contributionsCollection.contributionCalendar;
  const publicCalendar = await getPublicContributionCalendar();

  if (tokenCalendar.totalContributions !== publicCalendar.totalContributions) {
    console.warn(
      `Contribution total visible to the API token (${tokenCalendar.totalContributions}) ` +
        `differs from the public GitHub profile (${publicCalendar.totalContributions}); ` +
        "using the public profile calendar."
    );
  }

  // Search endpoints have a strict rate limit, so keep these requests serial.
  const commits = await searchCommitTotal(profile.user.createdAt);
  const prs = await searchTotal(`author:${USERNAME} type:pr`);
  const issues = await searchTotal(`author:${USERNAME} type:issue`);

  return {
    commits,
    prs,
    issues,
    calendar: publicCalendar,
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

function calculateGrade({ stars, commits, prs, issues, totalContributions }) {
  const score =
    commits * 1 +
    prs * 3 +
    issues * 2 +
    stars * 4 +
    totalContributions * 0.5;

  if (score >= 2000) return "A++";
  if (score >= 1000) return "A+";
  if (score >= 500) return "A";
  if (score >= 250) return "B+";
  if (score >= 100) return "B";
  return "C";
}

function gradeArc(grade) {
  const arcs = {
    "A++": 0.97,
    "A+": 0.88,
    A: 0.75,
    "B+": 0.62,
    B: 0.50,
    C: 0.35,
  };
  const pct = arcs[grade] || 0.5;
  const r = 35;
  const cx = 370;
  const cy = 100;
  const angle = pct * 360;
  const rad = (angle - 90) * (Math.PI / 180);
  const ex = cx + r * Math.cos(rad);
  const ey = cy + r * Math.sin(rad);
  const large = angle > 180 ? 1 : 0;
  return `M${cx} ${cy - r}A${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

function statsSvg({ stars, commits, prs, issues, contributions, calendar }) {
  const totalContributions = calendar.totalContributions;
  const contributedTo =
    contributions.totalRepositoriesWithContributedCommits || 0;

  const grade = calculateGrade({
    stars,
    commits,
    prs,
    issues,
    totalContributions,
  });

  const rows = [
    ["☆", "Total Stars", stars],
    ["⊙", "Total Commits", commits],
    ["⎇", "Total PRs", prs],
    ["●", "Total Issues", issues],
    ["◈", "Repos in API", contributedTo],
  ];

  const rowText = rows
    .map(
      ([icon, label, value], index) => `
        <text x="28" y="${78 + index * 22}" class="icon">${icon}</text>
        <text x="48" y="${78 + index * 22}" class="label">${escapeXml(label)}:</text>
        <text x="280" y="${78 + index * 22}" class="value">${compactNumber(value)}</text>`
    )
    .join("");

  return `
<svg width="420" height="195" viewBox="0 0 420 195" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(USERNAME)} GitHub Stats</title>
  <desc id="desc">Profile statistics generated from the GitHub API.</desc>
  <style>
    .title { fill: ${COLORS.title}; font: 600 15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .icon { fill: ${COLORS.muted}; font: 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .label { fill: ${COLORS.text}; font: 600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .value { fill: ${COLORS.text}; font: 700 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: end; }
    .grade { fill: ${COLORS.title}; font: 700 22px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
  </style>
  <rect x="0.5" y="0.5" width="419" height="194" rx="6" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <text x="24" y="40" class="title">My GitHub Statistics</text>
  ${rowText}
  <circle cx="370" cy="100" r="35" stroke="${COLORS.grid}" stroke-width="5"/>
  <path d="${gradeArc(grade)}" stroke="${COLORS.title}" stroke-width="5" stroke-linecap="round" fill="none"/>
  <text x="370" y="108" class="grade">${grade}</text>
</svg>
`.trimStart();
}

function languagesSvg(languages) {
  const topLanguages = languages.slice(0, 6);
  const total = topLanguages.reduce((sum, language) => sum + language.size, 0);
  let offset = 0;

  const barWidth = 310;
  const segments = topLanguages
    .map((language) => {
      const width = total ? (language.size / total) * barWidth : 0;
      const segment = `<rect x="${30 + offset}" y="${62}" width="${width.toFixed(
        2
      )}" height="8" fill="${language.color}" />`;
      offset += width;
      return segment;
    })
    .join("");

  const legend = topLanguages
    .map((language, index) => {
      const x = index % 2 === 0 ? 30 : 200;
      const y = 100 + Math.floor(index / 2) * 25;
      const percentage = total ? (language.size / total) * 100 : 0;
      return `
        <circle cx="${x}" cy="${y - 4}" r="5" fill="${language.color}"/>
        <text x="${x + 14}" y="${y}" class="legend">${escapeXml(
        language.name
      )} (${percentage.toFixed(2)}%)</text>`;
    })
    .join("");

  return `
<svg width="420" height="180" viewBox="0 0 420 180" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Most Used Languages</title>
  <desc id="desc">Language percentages across visible owned repositories.</desc>
  <style>
    .title { fill: ${COLORS.title}; font: 600 15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
    .legend { fill: ${COLORS.text}; font: 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }
  </style>
  <rect x="0.5" y="0.5" width="419" height="179" rx="6" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <text x="30" y="40" class="title">My Programming Languages</text>
  <clipPath id="bar"><rect x="30" y="62" width="${barWidth}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">
    <rect x="30" y="62" width="${barWidth}" height="8" fill="${COLORS.grid}"/>
    ${segments}
  </g>
  ${legend}
</svg>
`.trimStart();
}

function streakSvg(calendar) {
  const days = flattenDays(calendar);
  const streaks = getStreaks(days);
  const total = calendar.totalContributions;

  return `
<svg width="535" height="195" viewBox="0 0 535 195" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">GitHub Streak</title>
  <desc id="desc">Current and longest contribution streaks from GitHub contribution calendar.</desc>
  <style>
    .num { fill: ${COLORS.text}; font: 700 26px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .label { fill: ${COLORS.text}; font: 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .accent { fill: ${COLORS.title}; font: 700 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
    .date { fill: ${COLORS.muted}; font: 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; text-anchor: middle; }
  </style>
  <rect x="0.5" y="0.5" width="534" height="194" rx="6" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <line x1="178" y1="30" x2="178" y2="168" stroke="${COLORS.border}"/>
  <line x1="357" y1="30" x2="357" y2="168" stroke="${COLORS.border}"/>
  <text x="89" y="78" class="num">${compactNumber(total)}</text>
  <text x="89" y="108" class="label">Total Contributions</text>
  <text x="89" y="134" class="date">${formatDateRange(days[0]?.date, days.at(-1)?.date)}</text>
  <circle cx="267" cy="68" r="28" stroke="${COLORS.title}" stroke-width="4" fill="none"/>
  <text x="267" y="76" class="num">${streaks.current.count}</text>
  <text x="267" y="118" class="accent">Current Streak</text>
  <text x="267" y="142" class="date">${formatDateRange(streaks.current.start, streaks.current.end)}</text>
  <text x="446" y="78" class="num">${streaks.longest.count}</text>
  <text x="446" y="108" class="label">Longest Streak</text>
  <text x="446" y="134" class="date">${formatDateRange(streaks.longest.start, streaks.longest.end)}</text>
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
  const calendar = profile.calendar;

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
        tokenContributionsLastYear:
          profile.contributions.contributionCalendar.totalContributions,
        restrictedTokenVisible:
          profile.contributions.restrictedContributionsCount,
        reposWithCommitsTokenVisible:
          profile.contributions.totalRepositoriesWithContributedCommits,
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
