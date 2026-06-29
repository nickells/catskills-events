const CATEGORY_LABELS = {
  music: "Music",
  food: "Food & Drink",
  culture: "Arts & Culture",
  nature: "Nature & Outdoors",
  community: "Community",
  nightlife: "Nightlife",
  wellness: "Wellness",
  other: "Other",
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatEvents(events) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + (7 - today.getDay()));

  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const tonight = [];
  const thisWeek = [];
  const thisMonth = [];
  const later = [];

  for (const event of events) {
    if (!event.date) {
      thisMonth.push(event);
      continue;
    }

    const d = new Date(event.date + "T00:00:00");
    if (d < today) continue; // skip past events

    if (d.getTime() === today.getTime()) tonight.push(event);
    else if (d <= endOfWeek) thisWeek.push(event);
    else if (d <= endOfMonth) thisMonth.push(event);
    else later.push(event);
  }

  const sections = [];

  if (tonight.length) sections.push(formatSection("Tonight", tonight));
  if (thisWeek.length) sections.push(formatSection("This Week", thisWeek));
  if (thisMonth.length) sections.push(formatSection("This Month", thisMonth));
  if (later.length) sections.push(formatSection("Coming Up", later));

  return sections.join("\n\n");
}

function formatSection(title, events) {
  const byCategory = {};
  for (const event of events) {
    const cat = event.category || "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(event);
  }

  let out = `# ${title}\n`;

  for (const [cat, catEvents] of Object.entries(byCategory).sort()) {
    out += `\n## ${CATEGORY_LABELS[cat] || cat}\n`;

    const sorted = catEvents.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    for (const e of sorted) {
      const datePart = e.date ? formatDate(e.date) : "";
      const timePart = e.time && e.time !== "null" ? ` @ ${e.time}` : "";
      const venuePart = e.venue ? ` — ${e.venue}` : "";
      const townPart = e.town ? `, ${e.town}` : "";
      const desc = e.description ? `\n  ${e.description}` : "";

      out += `- **${e.name}** ${datePart}${timePart}${venuePart}${townPart}${desc}\n`;
    }
  }

  return out;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = DAY_NAMES[d.getDay()];
  const month = MONTH_NAMES[d.getMonth()];
  return `${day} ${month} ${d.getDate()}`;
}

export function formatJSON(events) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return events
    .filter((e) => {
      if (!e.date) return true;
      return new Date(e.date + "T00:00:00") >= today;
    })
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}
