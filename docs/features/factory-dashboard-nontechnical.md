# App Factory Dashboard — What the user sees

- **Feature ID:** `factory-dashboard`
- **Gate:** 2 (Analyse) — approved 2026-09-24
- **Audience:** product / design review. No code knowledge needed.

---

## Why this exists

Today, running a feature through the App Factory means typing a command for every step:
starting the factory, adding the request, checking status, and approving three times. The only
way to see progress is to open files and logs. The dashboard replaces all of that with one page
in your browser. After one command to open it, you never need the terminal again: you add
features, watch the agents work, read what they wrote, and approve or send work back, all from
the page.

The page runs only on your own computer. Nobody else can reach it, and there is no login.

---

## The page at a glance

One window with a narrow left column and a main area.

- **Top bar:** the project name, a factory status light (**Running** / **Stopped** / **Stopping…**),
  a **Start** or **Stop** button, a **Waiting for you** counter, and the total spend so far.
- **Left column:** the list of features, each with a small coloured stage label, plus an
  **Add feature** button at the top.
- **Main area:** whatever you selected: the overview, one feature, one ticket, or one agent's
  live work.

The browser tab title shows the waiting count, e.g. **(1) App Factory — calc-poc**, so you can
tell from another tab that something needs you.

---

## Journey 1 — Open the dashboard

1. In a terminal, type the one command that opens the dashboard for your project.
2. Your browser opens the dashboard on its own. The terminal shows the address in case the
   browser doesn't open.
3. The factory is **stopped** at first (grey light, "Stopped"), so opening the page never starts
   spending money by itself. Click **Start** when you are ready. In demo mode it starts on its
   own, because demo runs are free.
4. The overview screen shows:
   - **Waiting for you:** a highlighted card for each item that needs a decision, with a
     one-line reason and a **Review** button. Hidden when nothing is waiting.
   - **Running now:** which agent is working, on what, and for how long, with a **Watch live**
     link. It says "Idle, nothing to do" when no agent is running.
   - **Features:** one row per feature showing its stage on a progress strip (intake →
     refining → planning → ticketing → development → final check → done) and its ticket count.
   - **Recent activity:** a live feed of plain-language events, newest first, e.g.
     "Tests passed on T003", "QA approved T003", "T003 merged into the feature branch".

**Consistent with what exists:** the stages, names and IDs are exactly the ones you see in the
vault notes and in the guide, so the page and the notes always agree.

**Edge cases**
- *No features yet:* the overview shows a friendly empty state with a large **Add your first
  feature** button and one sentence on what happens next.
- *The factory is already running in a terminal:* the page shows "The factory is running in
  another window", and Start and Stop are greyed out with that explanation. Everything else
  works, including approving and rejecting.
- *The vault can't be found or its settings have an error:* the page opens but shows the error
  in plain words, with the file to fix, instead of a blank screen.

---

## Journey 2 — Add a feature

1. Click **Add feature**.
2. A form opens with:
   - **Name** (short, e.g. "Expression calculator"). It becomes the feature's ID; the form
     shows a preview such as `FEAT-EXPRESSION-CALCULATOR`.
   - **Priority:** High / Medium / Low (Medium preselected).
   - **Requirement:** a large text box for your request in your own words. A small hint below
     it says: "Give concrete examples of input and expected output — they become the
     acceptance criteria."
3. Click **Add feature**. The form closes and the new feature appears in the list at the
   **intake** stage, highlighted for a moment.
4. If the factory is running, the PM agent picks it up within seconds, and the stage changes
   to **refining** by itself.

**Edge cases**
- *Name already used by another feature:* the form refuses, and says which feature has that
  name.
- *Empty requirement or name:* the **Add feature** button stays disabled until both are filled.
- *A feature is already in progress:* the form is blocked. It shows "The factory builds one
  feature at a time for now. **Expression calculator** is still in development. Finish it (or
  let it be delivered) before adding the next one," with a link to that feature. The same rule
  applies from the terminal. (Running several features at once comes in a later milestone.)
- *Saving fails:* the form stays open with your text intact, and shows the reason.

---

## Journey 3 — Start and stop the factory

1. **Start:** click **Start** in the top bar. The light turns green, "Running".
2. **Stop:** click **Stop**. A confirmation appears inside the page: "Stop after the current
   agent finishes? Nothing is lost; you can start again any time." with **Stop** and
   **Cancel**.
3. After confirming, the light shows **Stopping…** until the running agent finishes, then
   **Stopped**. An agent can take several minutes, so while it's stopping a **Stop now** button
   appears. It asks once more ("This stops the running agent immediately; the work it was
   doing on this attempt is lost") and then stops at once.
4. **Emergency pause** (secondary, under a "More" menu): "Stop taking new work". The running
   agent finishes, but nothing new starts until you click **Resume new work**.

**Edge cases**
- *Start fails* (for example the target repo was moved or deleted): the light stays red, and a
  message says what's wrong in plain words.
- *You close the browser tab:* the factory keeps running. Reopening the address shows the
  current state.
- *You stop the dashboard command in the terminal:* the factory stops the same way as
  **Stop**, finishing the current agent first. Pressing Ctrl-C a second time stops it at once.
- *You're typing a note or a new feature while things change on screen:* what you type is
  never cleared or moved. The page updates around it.

---

## Journey 4 — Watch progress

### Feature page
Click a feature in the left column.

1. **Header:** name, stage, priority, total spend, and a progress strip with the current stage
   lit up.
2. **Tabs:**
   - **Overview:** your original request (exactly as written), the PM's refined version, and
     the acceptance criteria as a checklist.
   - **Plan:** the Tech Lead's plan: risks and the order of work.
   - **Tickets:** a board with one column per ticket stage (Backlog, Ready, In progress,
     Checks, Review, QA, Merge, Done, Needs you). A ticket waiting on your decision sits in
     **Needs you**. Each ticket is a card with its title, attempt count and spend. Cards move
     between columns live.
   - **History:** the feature's timeline, one line per step, with who did it (agent, factory
     or you) and when.

### Ticket page
Click a ticket card.

1. **Header:** title, stage, attempt number (e.g. "Attempt 2 of 3"), and which tickets it
   waits for.
2. **Sections, in order:** acceptance criteria, what the Developer did, the Code Reviewer's
   findings, QA's result for each criterion (pass / fail with the evidence), check results
   (tests / lint / build, each green or red, with a **Show output** link), and the timeline.

### Live agent view
Click **Watch live** on the overview, or any past run in a ticket's timeline.

1. A readable, scrolling log of what the agent is doing, in plain steps:
   - "Read `src/calc.ts`"
   - "Ran `npm test` — passed"
   - "Edited `src/evaluate.ts`"
   - The agent's own messages, shown as text.
2. New steps appear at the bottom as they happen. The view follows the newest step unless you
   scroll up to read.
3. A **Show raw log** switch shows the original lines, for debugging.
4. When the run ends, a footer shows the result, time taken and cost.

**Edge cases**
- *A run from before the dashboard existed:* it still shows. All past runs are readable.
- *A very long run:* older steps are shown in pages, with a **Show earlier steps** button.
- *A log line the page doesn't understand:* shown as "Unrecognised step", with the raw text
  available. The log never breaks.

---

## Journey 5 — Answer a checkpoint (the three approvals)

When the factory stops for you, the **Waiting for you** counter goes up, the tab title changes,
and (if you allowed it) a desktop notification appears: "calc-poc: the PM's requirement is
ready for your review."

1. Click **Review** on the waiting card (or the notification).
2. A review page opens, showing exactly what you're judging at this checkpoint:

| Checkpoint | What the page shows | The question at the top |
|---|---|---|
| After the PM | The refined requirement, in / out of scope, questions for the Tech Lead, acceptance criteria | "Is this what you meant?" |
| After ticketing | The plan's risks and the ticket list, each with its criteria and what it waits for | "Is this the right split, and can each ticket be built on its own?" |
| Final acceptance | The commit list, the files changed, all check results on the feature branch and on your main branch, and a note that this will merge into main and tag it | "Merge this into main?" |

3. Below that, a reply box: "Note for the next agent (optional for approve, required to send
   back)".
4. Two buttons: **Approve** and **Send back**.
   - **Approve** → the item moves on at once (the factory starts the next step straight away
     instead of waiting for its next check). The card disappears from "Waiting for you" and
     a short confirmation says what happened, e.g. "Approved. Planning has started."
   - **Send back** → requires a note. The page explains where the work goes, e.g. "This goes
     back to the PM with your note." The PM runs again.
5. At final acceptance, **Approve** first shows a confirmation inside the page: "This merges
   `feature/calculator` into `main` and tags it. Continue?" After it succeeds, the page shows
   "Delivered", with the tag name, and the feature moves to **done**.

**Edge cases**
- *Someone else already approved it* (for example from the terminal): the page shows "Already
  handled", refreshes, and the card disappears.
- *Main moved since the checks ran:* the page shows the same message the terminal does: "Your
  approval is held. The checks will re-run on the new main, and the feature will be delivered
  without asking you again."
- *The merge fails* (conflict, or checks went stale): the feature stays waiting, and the page
  shows the reason in plain words and what to do next. Nothing is marked delivered.
- *Approval fails for any other reason:* your note stays in the box, and the error is shown.
  Nothing is lost.

---

## Journey 6 — Handle an escalation

An escalation is when something went wrong and an agent or the factory needs you to decide,
for example a ticket failed three times, or QA found a problem in the criteria rather than
the code.

1. It appears under **Waiting for you** with a red reason label (e.g. "Failed 3 times",
   "Agent escalated", "Merge conflict", "Timed out").
2. **Review** opens a page with:
   - The full explanation, in the agent's or factory's own words.
   - Direct links to the relevant agent log and failing check output.
   - A plain "What you can do" box, e.g. "Fix the project description or the repo, then
     approve to try again."
3. The same reply box and **Approve** button. **Send back** only appears where sending back is
   possible. Otherwise a line says "Approving is the only way forward for this kind of pause."

---

## Journey 7 — Get notified

1. The first time something needs you, a small banner asks: "Get a desktop notification when
   the factory needs you?" with **Allow** and **Not now**.
2. With notifications allowed, each new waiting item raises one notification. Clicking it
   opens its review page.
3. Without notifications, the tab title count and the top-bar counter still show it.

---

## Journey 8 — Try it for free (demo mode)

For learning the dashboard without spending money on real agents.

1. Type the demo command in a terminal.
2. The dashboard opens on a ready-made practice project, with a sample feature already added.
3. Everything behaves like a real run (the stages, ticket board, live logs, all three
   approvals and delivery), but the agents are scripted and cost $0. Each agent step takes a
   few seconds so you can watch it.
4. A clear **DEMO** badge sits in the top bar the whole time, so a demo can never be mistaken
   for real work.
5. The practice project lives in its own throwaway folder and never touches your real repos.

---

## Things the dashboard deliberately does not do

- **Edit** requirements, plans, tickets or notes. You influence agents only through the note
  on Approve or Send back, the same rule as today.
- Show more than one project at a time (one dashboard per project, for now).
- Work from another computer or phone. It is reachable only from your own machine.
- Replace the terminal commands. They all keep working, and both can be used side by side.
