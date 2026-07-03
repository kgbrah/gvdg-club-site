import { safeExternalUrl } from './safe-url.js';
import {
  isClubEvent,
  parseHomepageEventCsv,
  parseHomepageEventDate,
  parseTournamentCsv,
  parseTournamentDate,
} from './home-feed-parse.js';

export {
  parseCsvLine,
  isClubEvent,
  parseHomepageEventCsv,
  parseHomepageEventDate,
  parseTournamentCsv,
  parseTournamentDate,
} from './home-feed-parse.js';

const TOURNAMENT_FEED_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRz6V6BAwII4eoqITz4MW5zmM_3mYJqrtqtZl9xB87lAZgDT1E0Do1r2cp2aa1tvEKWevnPhb2zQu4s/pub?gid=0&single=true&output=csv';
const EVENT_FEED_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTLTq17Bwgy6uW_9pG7dQODTmahv7vjxo9Y5EShHaeQYo9xPB2m7Nf5de8EcZvKgcrTbBLb97msMg4Q/pub?output=csv';
const RYDER_CUP_LEAGUE_URL = 'events.html#league/4';
const VISIBLE_LIMIT = 5;

function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function isRyderCupEvent(event) {
  return /\bryder\s*cup\b/i.test(String((event && event.title) || ''));
}

function makeTournamentItem(tournament, index) {
  const dateInfo = parseTournamentDate(tournament.date);
  const hidden = index >= VISIBLE_LIMIT;
  const item = document.createElement('a');
  const url = safeExternalUrl(tournament.url);
  item.className = 'tournament-item' + (hidden ? ' hidden-mobile' : '');
  item.href = url || '#';
  if (url) {
    item.target = '_blank';
    item.rel = 'noopener';
  }

  const date = document.createElement('div');
  date.className = 'tournament-date';
  if (dateInfo) {
    date.append(textEl('span', 'month', dateInfo.month), textEl('span', 'day', String(dateInfo.day)));
  } else {
    date.append(textEl('span', 'month', 'TBD'), textEl('span', 'day', '--'));
  }

  const info = document.createElement('div');
  info.className = 'tournament-info';
  info.appendChild(textEl('h4', 'tournament-name', tournament.name));
  const meta = document.createElement('div');
  meta.className = 'tournament-meta';
  if (tournament.location) meta.appendChild(textEl('span', 'tournament-location', '📍 ' + tournament.location));
  if (tournament.tier) meta.appendChild(textEl('span', 'tournament-tier', tournament.tier));
  info.appendChild(meta);

  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('class', 'tournament-arrow');
  arrow.setAttribute('width', '16');
  arrow.setAttribute('height', '16');
  arrow.setAttribute('viewBox', '0 0 24 24');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '9 18 15 12 9 6');
  arrow.appendChild(polyline);

  item.append(date, info, arrow);
  return item;
}

function makeEventItem(event, index) {
  const localUrl = isRyderCupEvent(event) ? RYDER_CUP_LEAGUE_URL : '';
  const url = localUrl || safeExternalUrl(event.url);
  const dateInfo = parseHomepageEventDate(event.date);
  const linked = url !== '';
  const hidden = index >= VISIBLE_LIMIT;
  const node = document.createElement(linked ? 'a' : 'div');
  const classes = ['event-item', 'fade-in', 'visible'];
  if (linked) classes.push('has-link');
  if (dateInfo.isTBD) classes.push('tbd-event');
  if (hidden) classes.push('hidden-extra');
  node.className = classes.join(' ');
  if (linked) {
    node.href = url;
    if (!localUrl) {
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
  }

  const date = document.createElement('div');
  date.className = dateInfo.isTBD ? 'event-date tbd' : 'event-date';
  date.appendChild(textEl('div', 'event-day', dateInfo.isTBD ? 'TBD' : String(dateInfo.day)));
  if (!dateInfo.isTBD) date.appendChild(textEl('div', 'event-month', dateInfo.month));

  const info = document.createElement('div');
  info.className = 'event-info';
  info.append(textEl('h3', 'event-title', event.title), textEl('p', 'event-description', event.description || ''));
  node.append(date, info);
  return node;
}

function replaceWithMessage(container, className, title, body) {
  const wrap = document.createElement('div');
  wrap.className = className;
  wrap.append(textEl('h3', '', title), textEl('p', '', body));
  container.replaceChildren(wrap);
}

export async function loadTournamentFeed(fetchImpl = fetch) {
  const list = document.getElementById('tournament-list');
  const toggleContainer = document.getElementById('tournament-toggle');
  const toggleButton = document.getElementById('toggle-btn');
  if (!list) return;
  let expanded = false;
  let total = 0;
  function toggle() {
    expanded = !expanded;
    list.classList.toggle('expanded', expanded);
    toggleButton.classList.toggle('expanded', expanded);
    toggleButton.querySelector('.toggle-text').textContent = expanded ? 'Show Less' : `Show All ${total} Tournaments`;
  }
  try {
    const response = await fetchImpl(TOURNAMENT_FEED_URL);
    if (!response.ok) throw new Error('feed_error');
    const tournaments = parseTournamentCsv(await response.text());
    if (tournaments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-tournaments';
      empty.appendChild(textEl('p', '', 'No upcoming tournaments found.'));
      list.replaceChildren(empty);
      return;
    }
    total = tournaments.length;
    list.replaceChildren(...tournaments.map((tournament, i) => makeTournamentItem(tournament, i)));
    if (toggleContainer && toggleButton && tournaments.length > VISIBLE_LIMIT) {
      toggleContainer.style.display = 'block';
      toggleButton.querySelector('.toggle-text').textContent = `Show All ${total} Tournaments`;
      toggleButton.addEventListener('click', toggle);
    }
  } catch (_e) {
    const error = document.createElement('div');
    error.className = 'no-tournaments';
    error.appendChild(textEl('p', '', 'Unable to load tournaments.'));
    list.replaceChildren(error);
  }
}

export async function loadHomepageEvents(fetchImpl = fetch, showPast = false) {
  const list = document.getElementById('eventList');
  if (!list) return;
  let expanded = false;
  let total = 0;
  function toggle() {
    expanded = !expanded;
    list.classList.toggle('expanded', expanded);
    const toggleButton = document.getElementById('event-toggle-btn');
    if (toggleButton) {
      toggleButton.classList.toggle('expanded', expanded);
      toggleButton.querySelector('.toggle-text').textContent = expanded ? 'Show Less' : `Show All ${total} Events`;
    }
  }
  try {
    const response = await fetchImpl(EVENT_FEED_URL + '&_cb=' + Date.now());
    if (!response.ok) throw new Error('feed_error');
    let events = parseHomepageEventCsv(await response.text());
    // "Events" here = tournaments & league rounds; club business (meetings/fundraisers/minutes) lives
    // under Club Events on the events page, so keep it off the homepage Events list.
    events = events.filter((event) => !isClubEvent(event));
    if (!showPast) events = events.filter((event) => !parseHomepageEventDate(event.date).isPast);
    events.sort((a, b) => parseHomepageEventDate(a.date).dateObj - parseHomepageEventDate(b.date).dateObj);
    total = events.length;
    if (events.length === 0) {
      replaceWithMessage(list, 'no-events', 'No Upcoming Events', 'Check back soon for new events!');
      return;
    }
    list.replaceChildren(...events.map((event, i) => makeEventItem(event, i)));
    const toggleContainer = document.getElementById('event-toggle-container');
    if (toggleContainer && events.length > VISIBLE_LIMIT) {
      toggleContainer.style.display = 'block';
      const toggleButton = document.getElementById('event-toggle-btn');
      toggleButton.querySelector('.toggle-text').textContent = `Show All ${total} Events`;
      toggleButton.addEventListener('click', toggle);
    } else if (toggleContainer) {
      toggleContainer.style.display = 'none';
    }
  } catch (_e) {
    replaceWithMessage(list, 'no-events', 'Events Loading...', 'Please check back shortly.');
  }
}

export function initHomeFeeds() {
  loadTournamentFeed();
  loadHomepageEvents();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHomeFeeds);
  else initHomeFeeds();
}
