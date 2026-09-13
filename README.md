# Antfarm

A living ant colony in a jar. It runs in real time, digs its own nest, raises its
own brood — and it depends on you to put food and water on the surface.

```bash
node server.js
```

Then open <http://localhost:8173>.

Or in Docker:

```bash
ANTFARM_USER=you ANTFARM_PASSWORD=something docker compose up --build
```

## Signing in

Watching the farm needs no account. **Signing in unlocks the controls that
change it** — pausing, speed, dropping food and water, auto-tend, founding a new
colony. Looking at pheromones, the nest plan, following an ant, framing the
view and clicking ants to inspect them all work signed out.

Credentials come from `ANTFARM_USER` and `ANTFARM_PASSWORD` and never reach the
browser; the server hands back a session token instead, and compares passwords
in constant time. The defaults are `keeper` / `antfarm`, and the server warns in
its log if you leave them.

Be clear about what this buys you. **The simulation runs in the browser**, so
the gate stops someone using the panel — not someone opening devtools. It is a
lock on the controls, not security. Real enforcement would mean moving the
simulation server-side, which is a much bigger job than this.

## The idea

Every ant runs the same tiny state machine. It senses a few local things — a
pheromone level, one distance-field reading, whatever is within a couple of
tiles — picks a state, and acts. No ant knows the plan. The nest, the foraging
trails and the division of labour are what happen when a few hundred of these
run at once.

That's the whole design constraint, and it's why you can have thousands of them:
an ant is ~90 bytes in a set of parallel typed arrays, and a full tick with 2000
ants costs about **0.5 ms** — roughly 30× faster than real time needs.

## You are the caretaker

The colony cannot survive on its own. Food piles and water get consumed, puddles
evaporate, and nothing replaces them but you.

- **Drop food** — click the button, then click the surface. Green crumbs.
- **Drop water** — same, blue puddle. Water drains faster than food, and an
  unwatered farm always dies of thirst first.
- **Auto-tend** — hand the job back to the farm. It keeps food and water topped
  up in proportion to the colony's size, in drops that also scale with it. It
  restocks whenever the stores run low, so the ration holds at any speed.

**Water goes near the entrance; food gets scattered.** That split is deliberate.
Thirst kills faster than hunger, so a reliable drink is what makes a long search
survivable — and it is how you'd tend a real farm anyway, topping up one
reservoir. Food lands anywhere inside the colony's foraging range, so they have
to go and look for it.

Feed them more often and the colony grows bigger; neglect it and it shrinks,
then starves. The side panel warns you before anything dies.

## What the ants do

| Caste | Job |
|---|---|
| **Queen** | Sits in the royal chamber and lays, but only out of genuine surplus — and only as much brood as the foragers can support. |
| **Forager** | Leaves the nest, finds food or water, hauls it home, and lays a pheromone trail so others find the same source. |
| **Digger** | Cuts tunnels and chambers, then hauls the spoil all the way out to the mound on the surface. |
| **Nurse** | Carries eggs to the nursery and feeds larvae. A larva only grows while it is being fed. |
| **Soldier** | Patrols, follows alarm pheromone, fights intruders, and raids. |
| **Undertaker** | Carries the dead out — to the waste chamber, or the midden if there isn't one yet. |

Workers **change jobs** as needs shift. That matters more than it sounds: with
caste fixed at birth, a colony that loses its last nurse during a famine can
never raise brood again, and dies later with a full larder.

## More than one colony

**New colony** asks how many queens to start with, one to three. Each is founded
on its own patch of ground, well apart from the others, and from then on they
are strangers: separate entrances, separate chambers, separate larders, separate
brood. Every ant belongs to exactly one nest and is drawn in its colours.

The only thing that connects them is that **an ant can smell a trail that is not
its own**. Everything else follows from that one signal.

- **Avoidance is the default.** An ant that meets a stranger backs away, and one
  carrying a load especially so. Real ants fight far less than folklore
  suggests: a skirmish costs workers nobody can spare.
- **Scarcity forces the issue.** A nest whose larder is running out stops
  avoiding and starts contesting. Two well-fed colonies will share a farm for
  hours and barely acknowledge each other.
- **Defending home needs no policy.** A stranger in your own tunnels is always
  worth biting, whatever the queen has decided this week.
- **Raids.** A hungry colony with numbers sends soldiers into a neighbour's nest
  to take food and water out of its store, and it arrives in *their* larder —
  the loot transfers, it isn't just destroyed. A raider with its arms full runs
  for home rather than fighting, and takes the hits on the way.
- **Estates.** A colony that loses its queen and its last worker is finished.
  Its chambers pass to the nearest surviving nest, along with whatever was in
  its store, and any brood still in its nursery is **raised as theirs**. Brood
  raiding is real ant behaviour, and it means a lost war can end with your
  daughters working for someone else.

### What a queen decides

The queen is the only thing in the simulation that makes a decision rather than
following a rule. She cannot see the farm. She knows how full her larder is, how
much room is left to dig, and how strongly her workers keep coming home smelling
of strangers — and she commits to a stance for a while:

| | |
|---|---|
| **Growing** | nurses and foragers; the default when things are fine |
| **Expanding** | diggers, when the nest is crowded for the rooms it has |
| **Defensive** | soldiers, when neighbours keep turning up |
| **Raiding** | soldiers, and sent out — hungry, threatened, and numerous enough |

The stance tilts what every new adult is raised as, so a nest that keeps meeting
strangers quietly turns into a nest full of soldiers. There is real randomness in
the choice, so two colonies in the same position do not always do the same
thing — and a small colony will not pick a fight whatever else is true.

Each nest's card shows what its queen is currently doing, whether she knows
about neighbours, and — once there is anything in it — its war ledger:

| | |
|---|---|
| **Enemy ants killed** | by this colony |
| **Brood captured** | another nest's young, now being raised as theirs |
| **Nests taken over** | whole colonies absorbed |
| **Stolen from rivals** / **Lost to raiders** | food and water, both directions |
| **Enemy dead eaten** | strangers' bodies carried home as protein |

## Looking for food

A colony's foraging range grows with its size: a big nest strips the ground near
home and has to push further out, which is why real colonies work larger
territories. Auto-tend scatters food across that range — always inside it, since
an ant turns back at the edge and would never reach a pile beyond.

Two rules make long-range searching work at all, and both were found the hard
way:

**Sweep, don't mill.** Left to drift, a searching ant reversed direction every
ten tiles or so and never got clear of its own doorstep. Food a hundred tiles
out simply never got found — 500-odd sat uncollected while the larder ran dry. A
searching ant now commits to a direction and holds it to the edge of its range.

**Turn back while you still can.** An ant heads home when its water won't cover
the return trip. Widening the search range without that rule just means dying
further from the nest.

The catch is arithmetic: a long round trip is most of a forager's day, so a load
has to be worth the walk. At four units a colony stalled at a fifth of the size
it reaches with food nearby; at eight it holds 50–100 again, with the searching
still real.

## Food buried in the soil

There are caches down there — call them root aphids, seeds, a dead beetle.
Digging is otherwise pure cost, and these give it a return, a direction, and
something two colonies can want at the same time.

They give off a smell that carries through soil, and it biases where a nest digs
— *slightly*. Lean on it too hard and colonies beeline for food and stop
building nests, which is worse to watch. Beyond that bias, a colony that can
smell a cache from ground it has already opened will cut a spur to it
deliberately, one prize at a time.

Every nest gets one placed within reach at founding, and with neighbours there
are more buried in the ground between them — a fixed prize both can reach is a
cleaner reason for two colonies to meet than waiting for one to get hungry.

They are finite and deliberately modest: in practice they run at **3–11% of a
colony's food intake**. A windfall and a flashpoint, not a food supply — the
farm still depends on you.

One nice property: the smell only changes when a cache is mined, so unlike the
trail pheromones it is computed on change rather than diffused every tick, and
costs essentially nothing per frame.

## The dead

An ant that dies leaves a body where it fell. Its substance does not come back
to anyone until an undertaker carries it out — real ants do this, and it has a
name: necrophoresis.

A body cleared properly returns its full biomass. A body left to rot returns
**40% of it, and the rest is simply lost**, which is the standing argument for
keeping undertakers on the payroll. A stranger's body is not refuse at all: it
is protein, and gets carried to the larder rather than the midden.

The colony notices bodies piling up the way it notices any other shortage —
after a bad fight it puts more hands on clearing the floor. Two undertakers were
enough to clear 80 of 95 bodies over a long run; without the crew, the same farm
left 40 lying in the tunnels and lost most of that biomass to rot.

## Adding a queen later

**Add queen**, then click the surface where she should dig in. She arrives as a
stranger — her own colour, her own entrance, a handful of workers and nothing
dug — while every existing colony carries on untouched. Useful when one nest has
run away with the farm and you want to put something new in its path.

The spot has to be clear of the farm's edges and at least 55 tiles from any
existing entrance; you'll be told if it isn't. Up to six nests.

## Click any ant

The inspector shows one individual: its caste, current goal, what it is
"thinking" (a readout of the rule that fired), health, energy, hydration, what
it is carrying, its age against its lifespan, how far it has walked, what it has
personally delivered or dug or fed — and a log of its recent actions.

It also shows its **pool slot and use count**, which is where the recycling is
visible.

## Recycling

Ants live in fixed typed arrays allocated once at startup. An ant *is* an index.

When one dies its index goes back onto a free stack and the next pupa to mature
reuses it — so `#412 · use 7` means six ants have already lived and died in that
slot. Nothing is allocated at runtime.

Its body goes back too: corpses return **biomass** to a shared pool, and every
new adult is built out of that pool plus the food its larva ate. A colony down
to just the queen can metabolise the pool into a starter crew, which is the only
reason a collapse is ever recoverable.

## The nest keeps growing

The colony wants roughly `8 + population/8` rooms, so **a bigger colony digs a
bigger nest** — and since population is set by how often you feed them, feeding
the farm is what makes it expand. There is no ceiling on the number of rooms:
what stops a nest is running out of ground it can reach, or dying. New rooms
branch off a chamber that is already dug rather than always going deeper, so the
nest spreads into a network.

**More ants, more ways in.** A nest cuts one more entrance per 55 ants, with no
upper limit. A single hole for a big colony is a queue, not an entrance. A new
shaft is sited 28+ tiles from the doors the nest already has and within
tunnelling reach of one of its rooms, and the diggers push a gallery out to it
and up through the ground line — straight through the spoil heap if that's
where it falls, the way mound-building ants do. The home field is seeded from
every entrance at once, so each ant simply uses whichever is nearest; nobody has
to choose. In a test colony of 170 ants, three doors opened in sequence and the
two new ones were carrying about a quarter of the traffic within a few thousand
ticks.

Getting there took three fixes worth knowing about, because each looked like a
different problem. Shafts were sunk *below* the ground line, so a finished one
was still capped by a tile of soil and never opened — and the colony queued a
fresh one on top, seventeen deep. Entrance siting ran after the "two open dig
faces" limit, so a busy colony never considered it at all. And siting depended
on how far the *rooms* had spread, so a crowded but compact nest could never
qualify for the entrances its population called for.

## When nests dig into each other

Left alone, nests grow *away* from each other. Rooms push outward toward
whichever side is free — measured, both nests in a test put more rooms on their
far side than toward their neighbour — and since the farm keeps adding ground at
its edges, the far side never runs out. Two colonies would essentially never
meet underground by accident.

So breaking through is deliberate, and driven by need rather than spite. A
colony **set on raiding**, or **boxed in** with no ground left to grow into,
drives a gallery at the rim of its neighbour's nearest room. Once it's cut, the
two tunnel systems are one — and raids start going underground without anybody
being told the tunnel exists, because a raider's route is always the shortest
open path to the rival's larder.

In a two-nest test, nest A was pushed into raiding at tick 18,000. Galleries went
in from both sides, and by tick 44,000 the tunnels had joined: raiders were
fighting inside each other's nests, with 340 food stolen one way, 325 the other,
and 105 ants killed between them.

Preservation still comes first. A nest only breaches under real pressure, and
a well-fed colony with room to grow never will.

## How a new entrance gets dug

A shaft is sited against a particular room, and it isn't a door until it is
**open to the sky and leads into that nest**. The work goes in two parts:
diggers walk out an existing door, open the hole at the turf, then bore a
straight gallery down to the room — digging the next tile on the line, or
stepping on if it's already open, and edging around stone.

Every piece of that fixes something that went wrong:

- **Approached from below**, diggers wandered whatever air pocket sat under the
  cap and never cut it. Shafts finished to within a tile of daylight, never
  opened, and were abandoned.
- **Cut from above** with nothing linking it down, a two-tile dimple in the
  turf counted as a door. Adoption now needs an underground path to one of the
  nest's rooms — searched through the ground, never the sky, where every hole
  joins every other.
- **The check looked at the wrong column.** The shaft sits mid-tile, and
  rounding sent the check one column over, where the ground was still capped.
  Shafts that had opened and connected were thrown away.
- **Diggers standing in the target room** tried to bore toward the spot they
  were already on, and jittered in place forever. They now go out and start from
  the top.
- **One room held the whole crew.** A digger only re-picks when its site is
  done, so 27 of 27 sat on a single room while the shaft timed out untouched. A
  site now keeps a crew of 8; the rest choose again.
- **Spoil built one-tile towers** beside the shaft, where loads had nowhere to
  slide. Loose soil can't rest on a spike, so now it doesn't: every grain needs
  a shoulder on at least one side.
- **A spot that failed isn't tried again.** One nest re-sited the same column
  three times running.

In the test after these fixes, both nests opened their second door on the first
attempt — bored 82 and 50 tiles down into the nest, and no failed shafts.

## Why a well-fed nest doesn't age out

The queen won't lay past the brood her colony can raise. That used to be judged
mostly by how many foragers there were, with the larder counting for one brood
per 60 food. A colony that turned defensive, trading foragers for soldiers,
could end up capped at 9 brood with 419 food and 330 water in store. Births fell
behind old age, and it shrank from 53 ants to 18 with nothing wrong but the
arithmetic.

An adult costs about 12 food all told: the egg, then five or six feedings as a
larva. So stored food now backs one brood per 12, on top of what the foragers
can keep supplying. It's still bounded by colony size, so a handful of nurses
isn't handed forty larvae. With the fix, both test nests grew steadily past 85
ants by tick 25,000.

## Two farms: the house farm and your own

The server hosts two things at once.

| | **The house farm** — `/` | **Run your own** — `/play` |
|---|---|---|
| Where the ants live | On the server, one colony for everyone | In your browser, yours alone |
| Watching | Anyone | You |
| Tending, speed, new colony | A signed-in keeper only | Anyone, no account |
| Saved | On the server (`ANTFARM_DATA`) | In your browser's storage |

The **Run your own** button on the house farm opens `/play` in a new tab, and
**Watch the house farm** there brings you back.

### How the house farm reaches your screen

The server loads the very same simulation files the browser runs, in a sandbox
with a stand-in `window`, and ticks them in real time. Nothing about the ants
differs between the two farms; only where the ticks happen.

Viewers connect to a single event stream. On connect they receive a
**keyframe**: the ordinary save file, loaded with the same code a page reload
uses. After that come small **frames**, ten a second by default:

- only the tiles that changed since the last frame,
- every ant packed into 11 bytes (position, heading, caste, nest, load, state)
  and every brood item into 12,
- food, water, bodies and intruders on the surface,
- the nests' stores, plans and war ledger, once a second.

Ants glide between frames, so they move smoothly at ten updates a second. The
stream is gzip-compressed. What only matters while someone is looking at it —
the pheromone overlay, or one ant's goals, thoughts and history in the
inspector — is fetched separately, and only then. One frame is built per tick of
the timer and shared by every viewer, so a hundred watchers cost about what one
does. A viewer too slow to keep up misses frames, and gets a fresh keyframe
when it catches up rather than a broken picture.

### Why the sign-in is real here

In a farm that runs in your browser, a locked button is only a locked button:
anyone can open devtools. In the house farm the colony isn't in your browser at
all. The page can only *ask* the server to drop food, change speed or start
over, and the server does it only for a request carrying a valid keeper token.
That token comes from signing in, and signing in means the name and password
the server compares, in constant time, against its own environment variables.
Neither ever reaches a browser.

Also on the server side:

- **Only the page and its scripts are served.** The server's own code, the
  saved farm and the Docker files are not reachable from a browser.
- **Rate limits.** At most 40 changes per 10 seconds per session. A wrong
  password costs a 400 ms wait, which blunts guessing.
- **Validated input.** Actions are checked for shape and range: a drop must be
  on the farm, a speed must be one of the slider's stops.
- **Sessions end on restart.** They're held in memory, and last 72 hours by
  default (`ANTFARM_SESSION_HOURS`).

## Running it with Docker

The keeper's name and password live only in a local `.env` file, which the
server reads at start-up. They are not in the image, not in the repository, and
never sent to a browser.

```bash
cp .env.example .env
```

Put a name and a long password in `.env`, then:

```bash
docker compose up -d --build
```

The house farm is saved to a named volume (`antfarm-data`), so it survives
restarts and rebuilds. It saves every 60 seconds and again on shutdown.

In production (`NODE_ENV=production`, as the image sets) there is **no fallback
login**: if either variable is missing, sign-in is switched off. The farm can
still be watched, and `/play` still works, but nobody can tend the house farm.
Running `node server.js` directly for development uses a throwaway
`keeper` / `antfarm` login, and the server's log warns about it.

| Variable | Default | |
|---|---|---|
| `ANTFARM_USER`, `ANTFARM_PASSWORD` | none in production | The keeper login |
| `ANTFARM_DATA` | `/data/house.json` in Docker | Where the house farm is saved |
| `ANTFARM_SESSION_HOURS` | 72 | How long a sign-in lasts |
| `ANTFARM_FRAME_HZ` | 10 | Updates per second sent to watchers (2–20) |
| `ANTFARM_MAX_VIEWERS` | 200 | Watchers at once |
| `ANTFARM_SAVE_SECONDS` | 60 | How often the house farm is saved |

Put it behind a reverse proxy with HTTPS before sharing the address. Sign-in
sends the password to the server, and without HTTPS anyone on the network path
could read it.

## The landing page

`landing/index.html` is a page about the project, styled to match
lastweeksproject.com, with the house farm running live in its window
(`/?embed=1` shows just the farm, no toolbar or panels).

It's served by the same deployment. Add the landing domain to the app, and tell
the server which domain it is:

```
ANTFARM_LANDING_HOSTS=antfarm.lastweeksproject.com
```

On that domain, `/` is the landing page; the farm stays on its own domain. To
look at the landing page before pointing any DNS, open `/landing` on any domain
the server answers to.

Only a couple of dig faces are ever open at once. Queue rooms faster than the
diggers can cut them and they thrash between sites, leaving every face
half-finished — the nest grows faster by working on less at a time.

A room that shows no progress while diggers are assigned to it eventually gets
written off (press `N` to see planned, in-progress and abandoned rooms). That
judgement is made on whether the hole is getting bigger, never on whether the
ants look busy: an ant cutting soil barely moves, and an ant walking toward an
unreachable chamber never stops moving.

## The farm itself grows

The farm starts wide — 400 tiles across by 200 deep — and the ground is not a
fixed box. When the nest nears a wall, or simply fills most of the farm, more
ground is added on that side and underneath, out to 1100×420. Every grid is
reallocated and everything holding a coordinate shifts with it. If you were
watching the whole farm, the view zooms out to keep showing it all; if you were
zoomed in, the view stays where it is.

This is slow on purpose. It takes a large, long-lived colony to fill the
starting ground, so the farm widening is a thing that happens over hours, not
minutes.

## Where the soil goes

Soil is conserved. Every tile cut out of a tunnel is carried up and becomes a
tile of the mound outside the entrance — the heap out there is made of the
tunnels behind it, and nothing is quietly deleted. Loads are not dropped if
there is nowhere to put them; the ant keeps carrying and tries further along.
Soil freed by an ant digging itself out of a collapse, or dropped by one that
died mid-haul, goes on a backlog that later diggers work off.

The books balance exactly: over a 150,000-tick run, 803 tiles dug, 792 dumped,
11 still owed, nothing unaccounted for.

**The heap behaves like loose soil.** An ant tips its load where it stands and
the grain rolls downhill until nothing around it is steeper than one tile per
column. That single rule is the whole mound: the shape, the slope, and the
limit on how tall a heap of a given width can stand all fall out of it. Nobody
decides to build a cone.

Two things keep the heap from ever becoming a tower:

**Ants carry spoil clear of the pile.** A digger walks until the ground under
it is close to the original level before tipping, rather than dropping its load
the moment it is outside. That alone took the peak from 26 tiles to 14 and
spread the base from 54 columns to 134.

**The heap weathers.** Every so often a grain creeps from high ground to low, so
slopes slowly slump outward on their own. Flat ground is left alone — it is
already stable — and only loose spoil moves, never the original terrain. Old
spoil buried underneath consolidates into ordinary soil, which is how a heap
stops reading as a pile and starts reading as ground.

Nothing is destroyed by either: weathering moves grains, it does not delete
them, and the raised ground still matches the soil dug out tile for tile. The
result is a wide, low rise that keeps extending outward for as long as the
colony keeps digging — a new surface laid slowly over the old one, with the
entrance shaft running up through it.

## How fast is 1×?

**Real time: a day in the farm is a day out here.**

The farm runs two clocks.

- **Movement** always runs at 20 ticks a second. Walking, carrying, digging a
  tile and fighting look the same at every speed.
- **Life** is everything biological: ageing, hunger and thirst, eggs and larvae
  growing, the queen laying, bodies rotting, puddles drying, the weather wearing
  down the spoil heap, and how often beetles turn up. It runs on its own clock,
  where `DAY_TICKS` make one colony day. At 1× that day takes a real day.

The **speed slider** only moves the life clock. It locks onto stops from 1× up
to 24×, where a colony day passes in an hour (`[` and `]` step it). The ants
don't rush about at 24×; they just live their lives faster.

**Digging sits between the two clocks.** Walking to the face and carrying spoil
out keep movement pace, but cutting a tile loose is slow. It takes about 66
seconds at 1×, shrinking with the square root of the speed to about 13 seconds
at 24× (`DIG_SLOW`). The cut has to be that slow to matter: a digger's trip out
with the spoil takes about 30 seconds, and anything shorter left the cut a small
part of the cycle. Measured on a new colony:

| | Tiles dug per real minute |
|---|---|
| Before (a cut every second) | 32.7 |
| 1× | 2.3 |
| 24× | 9 |

A farm takes a long time to dig out, as a real one would.

Because life is slow, the numbers are realistic-ish:

| | Colony time |
|---|---|
| Worker lifespan | 30–120 days |
| Queen lifespan | 10 years |
| Egg laid | about every 2.4 hours, around ten a day |
| Egg to adult | 3 days |

Real ants take six to eight weeks to go from egg to adult. Three days is the one
place the farm cheats, so a new farm shows its first brood coming through at the
faster speeds. With workers living months, each one does far more work, and the
queen needs far fewer eggs to keep the colony going.

One thing deliberately stays on the movement clock: how quickly a queen forgets
the scent of neighbours. Her workers spot strangers at walking pace, and if the
forgetting slowed 160× while the sightings didn't, every queen would be on
maximum alert forever.

Ages are 64-bit numbers. At 1× an ant ages a tiny fraction of a tick per
movement tick, and in 32-bit floats that step rounds away to nothing after about
ten colony days; a months-long life would simply stop ageing.

The loop takes fixed steps against the wall clock, so it holds its pace whether
the page renders at 60fps or 30, and a long stall (a sleeping laptop) is dropped
rather than fast-forwarded.

## It remembers

The farm autosaves to `localStorage` every 10 seconds and whenever you leave the
page, so a refresh puts you back with the same colony — the same tunnels, the
same stores, the same individual ants with their own statistics and slot reuse
counts. **New colony** is the only thing that throws it away, and it asks first.

If storage is unavailable (a private window, or the save outgrows the quota) the
farm still runs; it just won't survive a refresh.

## Controls

| | |
|---|---|
| `Space` | pause / resume |
| `F` / `W` | food / water tool (Auto-tend does it for you) |
| `P` | show pheromone trails (green = food trail, red = alarm) |
| `N` | show the nest blueprint and how far each chamber is dug |
| scroll / drag | zoom / pan |
| click an ant | inspect it |

Speed is a slider from 1× (real time) to 24× (keys `[` and `]` step it). The
farm keeps running while the window is hidden.

## Files

| | |
|---|---|
| `server.js` | static files plus the login API; no dependencies |
| `src/config.js` | every tunable constant — biology, costs, speeds, balance |
| `src/world.js` | soil, terrain, spoil physics, alarm scent, the growing farm |
| `src/nests.js` | per-colony chambers, navigation fields, private trail, queen policy |
| `src/colony.js` | ant and brood storage shared by every nest, the free-slot pool |
| `src/grid.js` | coarse spatial index, so ants can find the ants near them |
| `src/ai.js` | the per-ant state machines and the simulation tick |
| `src/render.js` | terrain raster, ants batched per nest and caste, overlays |
| `src/auth.js` | holds a session token; never sees a password |
| `src/main.js` | real-time loop, caretaker tools, inspector panel |

### How ants find their way

There is no per-ant pathfinder. Each nest keeps a handful of BFS distance fields
over open tiles — one from its entrance, one from its food store, one from its
nursery, one from its royal chamber — and an ant navigates by stepping downhill
on whichever field it currently cares about. Rebuilt only when the tunnels
actually change.

A chamber only counts as a colony's store or nursery once it is both dug *and*
reachable; otherwise ants queue against a wall trying to eat while the larder
sits full on the other side of the soil.

One consequence worth knowing, because it bit me: every nest's field covers the
*whole farm*, since all the tunnels open onto the same sky and the floods join
up there. So a field cannot tell you whose territory you are standing in — it
only tells you the way home. Territory is judged by which entrance is nearer
through the tunnels, which is a perfectly local thing for an ant to know. It is
also why a raider can route home from deep inside a rival nest with no special
handling at all: its own store field already points the way out and over.
