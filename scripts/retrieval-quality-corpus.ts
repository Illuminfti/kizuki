import type { SearchDocument } from "../packages/core/src/search/indexer";

/**
 * A synthetic vault for measuring retrieval. Every name, date and sentence is
 * invented. The shapes are the ones that matter: long entity pages, short
 * decision pages, loop-written digests that repeat everyone's words, and
 * chat-like captures that mention a topic without answering anything.
 */

export type QuestionKind =
  "keyword" | "paraphrase" | "decision" | "unanswerable";

export interface GoldenQuestion {
  kind: QuestionKind;
  query: string;
  /** Any of these documents answers it. Empty for an unanswerable question. */
  answers: readonly string[];
}

interface Entity {
  slug: string;
  title: string;
  type: "org" | "project" | "person";
  facts: string;
}

const ENTITIES: readonly Entity[] = [
  {
    slug: "kestrel",
    title: "Kestrel",
    type: "org",
    facts:
      "Kestrel supplies the object archive and bills quarterly. The account contact is Ines Duarte.",
  },
  {
    slug: "marlin",
    title: "Marlin",
    type: "project",
    facts:
      "Marlin is the data migration project. It is led by Tomas Bekele and targets the spring release.",
  },
  {
    slug: "osprey",
    title: "Osprey",
    type: "project",
    facts:
      "Osprey is the mobile client. The owner is Priya Raman and the beta ships in June.",
  },
  {
    slug: "heron",
    title: "Heron",
    type: "org",
    facts: "Heron is our legal counsel. The retainer renews every January.",
  },
  {
    slug: "plover",
    title: "Plover",
    type: "person",
    facts:
      "Plover Nakamura is the finance lead and approves every vendor invoice.",
  },
  {
    slug: "tern",
    title: "Tern",
    type: "project",
    facts:
      "Tern is the observability rollout covering logs, metrics and traces.",
  },
  {
    slug: "wren",
    title: "Wren",
    type: "org",
    facts: "Wren provides office space in Lisbon on a two year lease.",
  },
  {
    slug: "sable",
    title: "Sable",
    type: "person",
    facts: "Sable Okafor runs recruiting and owns the interview loop.",
  },
];

interface Decision {
  slug: string;
  title: string;
  body: string;
}

const DECISIONS: readonly Decision[] = [
  {
    slug: "pricing",
    title: "Pricing decision",
    body: "We decided to keep hosted pricing flat for the first year.",
  },
  {
    slug: "market-makers",
    title: "Market maker decision",
    body: "Decision: onboard two market makers before the public launch.",
  },
  {
    slug: "archive-vendor",
    title: "Archive vendor decision",
    body: "We chose Kestrel over two rivals for the object archive because of egress pricing.",
  },
  {
    slug: "hiring-pause",
    title: "Hiring pause decision",
    body: "We agreed to pause hiring until the Marlin migration finishes.",
  },
  {
    slug: "launch-date",
    title: "Launch date decision",
    body: "The launch moves to the second week of March.",
  },
  {
    slug: "security-review",
    title: "Security review decision",
    body: "We will run an external security review before the beta.",
  },
  {
    slug: "office-lease",
    title: "Office lease decision",
    body: "We renewed the Lisbon lease instead of moving offices.",
  },
  {
    slug: "client-name",
    title: "Client naming decision",
    body: "The mobile client will ship under the Osprey name.",
  },
];

const FILLER =
  "This page is maintained by the team and reviewed at the start of each quarter. " +
  "Open questions are tracked in the weekly notes, and history lives in the archive. " +
  "Links to related material are collected at the end of the page. ";

/** Sentences a digest repeats from every topic, so it matches almost any query a little. */
const DIGEST_TOPICS = [
  "Kestrel invoice noted",
  "Marlin migration status unchanged",
  "Osprey beta discussion continued",
  "pricing review pending",
  "hiring plan discussed",
  "launch checklist updated",
  "security review scheduled",
  "office lease paperwork filed",
  "Heron retainer reminder",
  "Tern dashboards refreshed",
  "Wren visit planned",
  "Sable interview loop staffed",
  "Plover approved invoices",
  "market makers mentioned",
];

const CAPTURES: readonly string[] = [
  "Reminder that the pricing review is on Friday.",
  "Quick note: the launch checklist has a new owner.",
  "Anyone free to look at the Kestrel invoice today?",
  "Osprey build is green again after the fix.",
  "Lunch on Thursday, Lisbon time, near the office.",
  "Can we talk about hiring next week?",
  "The Marlin migration dashboard is slow this morning.",
  "Forwarded the Heron retainer note to finance.",
];

function canon(
  slug: string,
  title: string,
  body: string,
  path: string,
  pageType: string,
): SearchDocument {
  return {
    docId: `page:${slug}`,
    scope: "canon",
    title,
    body,
    path,
    pageType,
    sensitivity: "personal",
    taint: "clean",
    authority: "owner_authored",
    occurredAt: "",
    connectorId: "",
    subjects: [],
    provenance: [],
  };
}

function capture(index: number, body: string): SearchDocument {
  return {
    docId: `event:capture-${index}`,
    scope: "ledger",
    title: "chat message",
    body,
    path: "",
    pageType: "message",
    sensitivity: "personal",
    taint: "quoted",
    authority: "connector_evidence",
    occurredAt: `2026-03-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
    connectorId: "chat",
    subjects: [],
    provenance: [],
  };
}

/** Entity pages are long on purpose: length normalisation must not bury them. */
export function syntheticDocuments(): SearchDocument[] {
  const docs: SearchDocument[] = [];
  for (const entity of ENTITIES) {
    docs.push(
      canon(
        `entity-${entity.slug}`,
        entity.title,
        `${entity.facts} ${FILLER.repeat(8)}`,
        `entities/${entity.slug}.md`,
        entity.type,
      ),
    );
  }
  for (const decision of DECISIONS) {
    docs.push(
      canon(
        `decision-${decision.slug}`,
        decision.title,
        decision.body,
        `decisions/${decision.slug}.md`,
        "fact",
      ),
    );
  }
  ENTITIES.forEach((entity, index) => {
    docs.push(
      canon(
        `note-${entity.slug}`,
        `${entity.title} weekly note`,
        `Weekly note. ${entity.title} came up briefly and nothing changed. ${FILLER}`,
        `notes/${entity.slug}-weekly-${index}.md`,
        "topic",
      ),
    );
  });
  for (let day = 1; day <= 24; day += 1) {
    const topics = DIGEST_TOPICS.filter((_, index) => (index + day) % 2 === 0);
    docs.push(
      canon(
        `digest-${day}`,
        `Daily digest ${day}`,
        `Digest. ${topics.join(". ")}.`,
        `auto/digests/day-${String(day).padStart(2, "0")}.md`,
        "rollup",
      ),
    );
  }
  CAPTURES.forEach((body, index) => docs.push(capture(index, body)));
  return docs;
}

const entity = (slug: string): string => `page:entity-${slug}`;
const decision = (slug: string): string => `page:decision-${slug}`;

export function goldenQuestions(): GoldenQuestion[] {
  const keyword: [string, string[]][] = [
    ["Kestrel", [entity("kestrel")]],
    ["Marlin", [entity("marlin")]],
    ["Osprey", [entity("osprey")]],
    ["Heron retainer", [entity("heron")]],
    ["Plover finance", [entity("plover")]],
    ["Tern observability", [entity("tern")]],
    ["Wren lease Lisbon", [entity("wren"), decision("office-lease")]],
    ["Sable recruiting", [entity("sable")]],
    ["market makers", [decision("market-makers")]],
    ["security review beta", [decision("security-review")]],
    ["object archive", [entity("kestrel"), decision("archive-vendor")]],
    ["flat pricing", [decision("pricing")]],
  ];
  const paraphrase: [string, string[]][] = [
    ["Who is in charge of the Marlin migration?", [entity("marlin")]],
    ["Which company supplies our object archive?", [entity("kestrel")]],
    ["When will the Osprey beta ship?", [entity("osprey")]],
    ["Who approves the vendor invoices?", [entity("plover")]],
    ["Where do we rent office space in Lisbon?", [entity("wren")]],
    ["Who handles the interview loop?", [entity("sable")]],
    ["What does the Tern rollout cover?", [entity("tern")]],
    ["Which firm is our legal counsel?", [entity("heron")]],
    ["When does the Heron retainer renew?", [entity("heron")]],
    ["Who owns the Osprey mobile client?", [entity("osprey")]],
  ];
  const decisions: [string, string[]][] = [
    ["What did we decide about pricing?", [decision("pricing")]],
    [
      "What did we decide about market makers for the launch?",
      [decision("market-makers")],
    ],
    [
      "Why did we choose Kestrel for the archive?",
      [decision("archive-vendor")],
    ],
    ["Did we agree to pause hiring?", [decision("hiring-pause")]],
    ["When did the launch date move?", [decision("launch-date")]],
    [
      "Are we running a security review before the beta?",
      [decision("security-review")],
    ],
    ["What happened with the Lisbon lease?", [decision("office-lease")]],
    ["What name will the mobile client ship under?", [decision("client-name")]],
  ];
  const unanswerable = [
    "What is the airspeed velocity of an unladen swallow?",
    "Who won the football match last night?",
    "What is the capital of Mongolia?",
    "How do I bake sourdough bread?",
    "When does the Lisbon marathon start?",
    "What is the weather forecast for Osprey Island?",
    "Which planet has the most moons?",
    "Who painted the ceiling of the chapel?",
    "What time does the Kestrel volcano erupt?",
    "How many strings does a cello have?",
  ];
  return [
    ...keyword.map(([query, answers]): GoldenQuestion => ({
      kind: "keyword",
      query,
      answers,
    })),
    ...paraphrase.map(([query, answers]): GoldenQuestion => ({
      kind: "paraphrase",
      query,
      answers,
    })),
    ...decisions.map(([query, answers]): GoldenQuestion => ({
      kind: "decision",
      query,
      answers,
    })),
    ...unanswerable.map((query): GoldenQuestion => ({
      kind: "unanswerable",
      query,
      answers: [],
    })),
  ];
}
