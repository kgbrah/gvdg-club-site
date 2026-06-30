# Greenville Disc Golf Club Design System

## 1. Atmosphere & Identity

Greenville Disc Golf Club should feel local, energetic, outdoors-focused, and easy to scan on a phone before or after a round. The signature is a high-contrast orange and blue sport palette over light/dark surfaces with forest imagery, condensed display headings, and compact event cards.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Accent/primary | `--primary` | `#FF6B35` | `#FF6B35` | CTAs, links, active states, date badges |
| Accent/secondary | `--secondary` | `#004E89` | `#004E89` | Gradients, supporting actions |
| Accent/warm | `--accent` | `#F7B801` | `#F7B801` | Price and highlight details |
| Accent/green | `--green` | `#2D5016` | `#2D5016` | Club/nature gradient accents |
| Score/conflict | `--over` | `#C8472E` | `#FF7A5C` | Over-par labels, scoring conflicts, blocking error states |
| Score/conflict soft | `--over-soft` | `rgba(200, 71, 46, 0.10)` | `rgba(255, 122, 92, 0.16)` | Conflict row and cell backgrounds |
| Surface/primary | `--bg-primary` | `#F4F4F9` | `#0F0F1E` | Page background, nested card surfaces |
| Surface/secondary | `--bg-secondary` | `#FFFFFF` | `#1A1A2E` | Main section panels and modals |
| Surface/tertiary | `--bg-tertiary` | `#F4F4F9` | `#252538` | Metadata strips and inset panels |
| Text/primary | `--text-primary` | `#1A1A2E` | `#F4F4F9` | Headings and primary labels |
| Text/secondary | `--text-secondary` | `#333333` | `#E0E0E0` | Body copy |
| Text/tertiary | `--text-tertiary` | `#555555` | `#C0C0C0` | Supporting metadata |
| Text/muted | `--text-muted` | `#666666` | `#A0A0A0` | Captions, empty states |
| Border/default | `--border-color` | `#F4F4F9` | `#2A2A3E` | Cards, dividers, outlines |
| Shadow/default | `--card-shadow` | `rgba(0, 0, 0, 0.1)` | `rgba(0, 0, 0, 0.3)` | Section and card elevation |
| Shadow/hover | `--card-shadow-hover` | `rgba(0, 0, 0, 0.15)` | `rgba(0, 0, 0, 0.5)` | Hover elevation |

### Rules

- Prefer existing CSS variables over raw colors.
- New semantic colors must be added here before use.
- Gradients combine `--primary`, `--secondary`, and `--green` only when the element is a major CTA, badge, or sport-themed feature.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Hero display | `clamp(2.5rem, 8vw, 5rem)` | 400 | 1.1 | `0.05em` | Hero title |
| Section display | `clamp(2rem, 6vw, 3.5rem)` | 400 | 1.1-1.2 | `0.05em` | Section titles |
| Slide title | `clamp(1.8rem, 4vw, 2.8rem)` | 400 | 1.2 | `0.03em` | Carousel and panel headings |
| Card title | `1.2rem-1.6rem` | 400 | 1.2-1.3 | `0.02em-0.03em` | Event, course, and contact cards |
| Body | `1rem` | 400 | 1.6 | `0` | Default copy |
| Body/sm | `0.85rem-0.95rem` | 400-600 | 1.4-1.5 | `0` | Metadata and subtitles |
| Caption | `0.65rem-0.8rem` | 600-700 | 1.2-1.4 | `0.03em-0.05em` | Badges and date labels |

### Font Stack

- Display: `Bebas Neue, sans-serif`
- Body: `Archivo, system-ui, -apple-system, sans-serif`

### Rules

- Use `Bebas Neue` for headlines, date numbers, and compact card labels.
- Body text stays in `Archivo`.
- Avoid negative letter spacing; the current system uses neutral or positive tracking.

## 4. Spacing & Layout

### Base Unit

Spacing follows a 4px base through rem values.

| Token | Value | Usage |
|-------|-------|-------|
| Tight | `0.25rem-0.5rem` | Inline metadata, icon-to-text gaps |
| Compact | `0.75rem-1rem` | Small controls and card internals |
| Standard | `1.25rem-1.5rem` | Event/card padding |
| Comfortable | `2rem` | Section internals and modals |
| Section | `clamp(2rem, 6vw, 4rem)` | Major content sections |
| Page max | `1200px` | Main content width |

### Grid

- Mobile: single-column stacks.
- Tablet/Desktop: responsive grids with `minmax(250px, 1fr)` or `minmax(300px, 1fr)`.
- Main sections are constrained to about `1200px` and centered.

### Rules

- Keep cards and controls stable across hover states; transforms must not alter layout flow.
- On mobile, preserve single-column event and tournament lists with no horizontal scrolling.

## 5. Components

### Event Item

- Structure: date badge, text content, optional link wrapper.
- Variants: linked, TBD, hidden-extra.
- Spacing: `1.5rem` gap and padding on desktop, tighter on mobile.
- States: hover translates slightly and changes surface/elevation; linked cards use `has-link`.
- Accessibility: linked events are real anchors with safe external URLs.
- Motion: transform and opacity only.

### Tournament Item

- Structure: date badge, event metadata, arrow icon.
- Variants: hidden-mobile, expanded.
- Spacing: `0.75rem-1.25rem` padding depending on viewport.
- States: hover translates on desktop; toggle expands hidden mobile rows.
- Accessibility: external links include `rel="noopener"`.
- Motion: transform and opacity only.

### Toggle Button

- Structure: text span plus chevron icon.
- Variants: collapsed, expanded.
- Spacing: `0.75rem 1.5rem`.
- States: hover fills with `--primary`; expanded rotates icon.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | `0.2s` | ease | Toggle hover and small state changes |
| Standard | `0.3s` | ease | Card hover, menu, carousel controls |
| Reveal | `0.6s` | ease | Section and fade-in entrances |

### Rules

- Animate `transform`, `opacity`, and color changes.
- Existing carousel, reveal, and hover behavior should be preserved.
- Do not remove loading, empty, or error feed states to simplify scripts.

## 7. Depth & Surface

### Strategy

Depth is mixed: soft shadows for elevated cards/sections, borders for cards and controls, and tonal shifts for dark mode.

| Level | Value | Usage |
|-------|-------|-------|
| Border | `1px-2px solid var(--border-color)` | Cards, controls, modals |
| Section shadow | `0 10px 40px var(--card-shadow)` | Main section panels |
| Hover shadow | `0 10px 30px var(--card-shadow-hover)` | Interactive cards |
| Modal shadow | `0 20px 60px rgba(0, 0, 0, 0.3)` | Modal overlays |

### Rules

- Use borders and shadows together only where the existing pattern already does.
- Dark mode relies more on tonal surfaces and lower-contrast borders.
