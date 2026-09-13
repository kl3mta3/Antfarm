// Antfarm — tunable constants.
// Everything the sim balances on lives here so you can fiddle without hunting.
(function () {
  const AF = (window.AF = window.AF || {});

  AF.CFG = {
    // ---- world ----
    W: 400,          // tiles across (grows as the nest reaches the edges)
    H: 200,          // tiles down — deep enough that the nest has somewhere to go
    MAX_W: 1100,     // how far the farm may ever grow
    MAX_H: 420,
    GROW_MARGIN: 22, // start expanding when the nest comes this close to a wall
    GROW_STEP_X: 60,
    GROW_STEP_Y: 45,
    TILE: 4,         // pixels per tile at zoom 1
    SKY: 30,         // rows of open air above the soil

    // ---- population limits ----
    // Simulation pace. 20 ticks a second reads like an ant farm you are
    // watching; 60 made everything scurry. All biology is counted in ticks, so
    // changing this rescales the whole clock without touching the balance.
    BASE_HZ: 20,
    TEND_EVERY: 120,   // ticks between auto-tend checks

    // One clock. At 1× the farm runs in real time: a colony day takes a real
    // day. The speed slider runs more ticks a second, so everything speeds up
    // together — walking, digging, eating, ageing, the queen laying — and a
    // colony day at 24× passes in an hour with a full day's work done in it.
    // DAY_TICKS is how much colony time makes a day; biology is measured in it.
    DAY_TICKS: 10800,
    // How fast ants walk at 1×, as a share of the per-tick caste speeds below.
    // Real time looks like the farm did before, only slower.
    WALK_PACE: 0.5,
    SPEED_STOPS: [1, 2, 3, 4, 6, 8, 12, 16, 24],

    MAX_ANTS: 6000,
    MAX_BROOD: 1500,
    MAX_PILES: 26,
    START_WORKERS: 24,

    // ---- biology (in life ticks: DAY_TICKS of them make a colony day) ----
    // Egg to adult in three colony days. A real colony takes six to eight
    // weeks; this is the one place the farm cheats, so a new farm shows its
    // first brood coming through within a sitting at the faster speeds.
    EGG_T: 7200,       // egg -> larva     (16 hours)
    LARVA_T: 14400,    // larva -> pupa    (32 hours; only advances while fed)
    PUPA_T: 10800,     // pupa -> adult    (a day)
    // Workers live months, like real ones: each does far more work in its
    // life, and the queen needs to lay far fewer to keep the colony going.
    // A wide spread still matters — with lifespans close together, everyone
    // born in one burst dies in one burst, and the colony swings between boom
    // and near collapse instead of settling.
    LIFE_MIN: 324000,   // 30 days
    LIFE_MAX: 1296000,  // 120 days
    // Real queens live for years.
    QUEEN_LIFE: 39420000,   // 10 years

    ENERGY_MAX: 100,
    ENERGY_DRAIN: 0.013,
    HUNGRY_AT: 42,      // energy below this -> go eat
    EAT_TICKS: 90,
    MEAL_COST: 1.4,     // colony food burned per meal

    // Thirst. Drains faster than hunger — an unwatered farm dies first of this.
    HYDRATION_MAX: 100,
    THIRST_DRAIN: 0.016,
    THIRSTY_AT: 45,
    DRINK_TICKS: 60,
    SIP_COST: 1.0,      // colony water burned per drink
    DEHYDRATION_DAMAGE: 0.11,

    // ---- reproduction & the resource pool ----
    EGG_FOOD_COST: 5,
    // With workers living months, she can take her time: an egg every couple
    // of colony hours, about ten a day, holds a colony of several hundred.
    EGG_INTERVAL: 1080,     // life ticks between lays (2.4 h; slower when food is short)
    FEED_COST: 1.0,         // food per larva feeding
    FEED_VALUE: 120,        // nutrition granted per feeding
    // Sized so a larva still needs about six feedings over its 32 hours —
    // the larder was balanced around that, at roughly 12 food per new adult.
    LARVA_BURN: 0.05,       // nutrition a larva burns per life tick while growing
    FEED_RESERVE: 22,       // larder kept back for adults before brood is fed
    BROOD_PER_FORAGER: 0.55, // she will not lay beyond what the foragers support
    BIOMASS_PER_ANT: 4,     // pool cost to build an adult body
    BIOMASS_RETURN: 2.8,    // corpse gives this back to the pool
    FOOD_FROM_CORPSE: 0.8,  // cannibalised nutrition

    // ---- work ----
    DIG_TICKS: 22,         // movement ticks to loosen one tile, before DIG_SLOW
    // Cutting a tile loose is slow: DIG_SLOW times DIG_TICKS, about 66 seconds
    // at 1× (an ant chewing soil loose), and faster with the slider like
    // everything else. It has to be this large to matter: a digger's trip out
    // with the spoil is long, so a shorter cut was a small part of the cycle.
    // Without it a crew could dig out a farm in a day.
    DIG_SLOW: 60,
    DIG_LOAD: 3,           // tiles cut before hauling the spoil out
    // What one ant brings back in a trip. Once food is scattered, the round
    // trip is most of a forager's day, so a load has to be worth the walk — at
    // 4 the colony stalled at a fifth of the size it reaches with food nearby.
    FOOD_PER_TRIP: 8,
    WATER_PER_TRIP: 6,
    PILE_AMOUNT: 120,      // food in one caretaker drop
    PUDDLE_AMOUNT: 110,    // water in one caretaker drop
    EVAPORATION: 0.0032,   // puddles dry out if nobody collects them
    SPOIL_STEP: 1,         // steepest step loose spoil will hold before it slides
    SPOIL_CEILING: 5,      // spoil never piles above this row; it spreads instead
    SPOIL_EDGE: 4,         // spoil this thick counts as "on the heap" — walk further
    SPOIL_WALK_MAX: 320,   // but never trek further than this to find the edge
    ERODE_EVERY: 60,       // ticks between weathering passes over the spoil
    ERODE_SAMPLES: 5,      // columns weathered per pass
    COMPACT_CHANCE: 0.25,  // odds a buried spoil tile settles into ordinary soil
    WILD_FOOD: false,      // true = food appears on its own (caretaker off duty)
    WILD_FOOD_EVERY: 2400,

    // ---- pheromones ----
    PH_DECAY: 0.9955,
    PH_DIFFUSE_EVERY: 6,
    PH_MAX: 8,
    TRAIL_DROP: 0.55,
    ALARM_DROP: 1.6,
    TRAIL_SENSE: 0.04,
    // How far a searching ant will roam. A bigger colony strips the ground near
    // home and has to push further out, so the range grows with it.
    FORAGE_RANGE: 70,
    FORAGE_PER_ANT: 7,      // extra tiles per sqrt(ant), roughly
    FORAGE_RANGE_MAX: 190,
    PILE_SENSE: 48,         // how far off an ant notices a pile
    // An ant turns for home while it still has the water to get there. Without
    // this, widening the range just means dying further from the nest.
    RETURN_MARGIN: 1.5,     // safety factor on the estimated trip home
    RETURN_RESERVE: 14,     // hydration kept back on top of that

    // ---- entrances ----
    // A nest of any size has more than one way in. Real ones do, and a single
    // hole is a bottleneck: every ant in the colony queues through one tile.
    // One more way in per this many ants, with no ceiling — a bigger nest
    // simply has more doors. What limits them is ground, not a number: they
    // must be spaced out, and clear of the spoil heap.
    ANTS_PER_ENTRANCE: 55,
    ENTRANCE_MIN_GAP: 28,    // tiles between a nest's own entrances

    // ---- food buried in the soil ----
    // Caches of something worth eating — root aphids, seeds, a dead beetle.
    // Digging is otherwise pure cost, and these give it a return, a direction,
    // and something for two colonies to want at the same time.
    // Sized to be a windfall, not a food supply. Fully mined out, all the
    // caches on a farm come to roughly a third of what one large colony eats
    // in a lifetime — worth digging for, nowhere near enough to live on.
    CACHE_CLUSTERS: 9,
    CACHE_RADIUS: 2.6,
    CACHE_YIELD: 5,          // food per tile cut out of one
    CACHE_SCENT_RANGE: 34,   // how far the smell carries through soil
    CACHE_SCENT_BIAS: 0.55,  // how hard a digger leans toward it — keep it slight
    CACHE_MIN_DEPTH: 12,     // never right under the surface

    // ---- speeds (tiles per tick) ----
    SPD_FORAGER: 0.135,
    SPD_DIGGER: 0.115,
    SPD_NURSE: 0.09,
    SPD_SOLDIER: 0.13,
    SPD_QUEEN: 0.022,

    // ---- caste balance the colony aims for ----
    CASTE_TARGET: { forager: 0.42, digger: 0.22, nurse: 0.21, soldier: 0.09, undertaker: 0.06 },

    // ---- the dead ----
    // Ants carry their dead out. A body left in the tunnels is a disease risk,
    // and a rival's body is protein worth fetching home.
    MAX_CORPSES: 400,
    CORPSE_ROT: 9000,        // ticks before a body decomposes where it lies
    CORPSE_ROT_RETURN: 0.4,  // of its biomass, recovered if nobody clears it
    CORPSE_PROTEIN: 5,       // food a stranger's body is worth, carried home
    SPD_UNDERTAKER: 0.105,

    // ---- neighbours ----
    // Ants meeting another colony avoid it by default. Real ants fight far less
    // than folklore suggests: a skirmish costs workers nobody can spare, so it
    // takes real pressure — hunger, or nowhere left to dig — to force one.
    FOREIGN_SENSE: 0.08,     // foreign scent this strong registers at all
    AVOID_TURN: 0.5,         // how hard an ant turns away from a foreign trail
    HOSTILE_FOOD: 45,        // below this in the larder, competition turns nasty
    HOSTILE_CROWD: 0.75,     // nest this full of its own plan -> pressure for room
    FIGHT_DAMAGE: 0.9,       // per tick, ant on ant
    // A colony under real pressure — set on raiding, or boxed in with no ground
    // left — tunnels toward a neighbour's nearest room if it lies this close.
    BREACH_RANGE: 70,
    RAID_CARRY: 5,           // food or water a raider takes per trip
    RAID_RANGE: 2.0,         // how close a raider must get to a rival larder
    // A queen should remember her neighbours for a good while — at 0.995 the
    // memory was gone inside fifteen seconds and no colony ever reacted.
    THREAT_DECAY: 0.9996,
    THREAT_PER_SIGHTING: 0.9,
    POLICY_REVIEW: 900,      // ticks between a queen reconsidering her strategy

    // ---- threats ----
    INTRUDER_EVERY: 6500,
    INTRUDER_HP: 70,
    INTRUDER_BITE: 7,
    INTRUDER_BITE_EVERY: 20,
    INTRUDER_PATIENCE: 5000, // gives up and leaves rather than camping forever

    FIELD_REBUILD_EVERY: 40, // ticks between navigation-field rebuilds
  };

  // Tile kinds
  AF.T = { AIR: 0, SOIL: 1, ROCK: 2, MOUND: 3, CACHE: 4 };

  // Castes
  AF.CASTE = { QUEEN: 0, FORAGER: 1, DIGGER: 2, NURSE: 3, SOLDIER: 4, UNDERTAKER: 5 };
  AF.CASTE_NAME = ['Queen', 'Forager', 'Digger', 'Nurse', 'Soldier', 'Undertaker'];
  AF.CASTE_COLOR = ['#f2c14e', '#d98b3a', '#a9713f', '#8fb8c9', '#c7553f', '#8d8596'];
  AF.CASTE_KEY = ['queen', 'forager', 'digger', 'nurse', 'soldier', 'undertaker'];
  AF.NCASTE = 6;

  // What an ant can be holding
  AF.CARRY = { NONE: 0, FOOD: 1, DIRT: 2, EGG: 3, WATER: 4, CORPSE: 5 };
  AF.CARRY_NAME = ['nothing', 'a food parcel', 'a ball of soil', 'an egg',
                   'a droplet of water', 'a body'];

  // Behaviour states
  AF.ST = {
    IDLE: 0, LEAVE_NEST: 1, SEEK_FOOD: 2, TO_FOOD: 3, HAUL_FOOD: 4, STORE_FOOD: 5,
    TO_DIG: 6, DIGGING: 7, HAUL_DIRT: 8, DUMP_DIRT: 9,
    TEND: 10, TO_LARVA: 11, FEEDING: 12, HAUL_EGG: 13,
    GO_EAT: 14, EATING: 15, LAY: 16, PATROL: 17, RESPOND: 18, FIGHT: 19, REST: 20,
    SEEK_WATER: 21, TO_WATER: 22, GO_DRINK: 23, DRINKING: 24,
    RAID_OUT: 25, RAID_TAKE: 26, RAID_HOME: 27, AVOID: 28,
    SEEK_BODY: 29, TO_BODY: 30, HAUL_BODY: 31, DUMP_BODY: 32,
    FETCH_ROYAL: 33, TO_QUEEN: 34, FEED_QUEEN: 35,
  };
  AF.ST_NAME = [
    'Idle', 'Heading out', 'Searching', 'Closing on food', 'Hauling food', 'Storing food',
    'Walking to dig site', 'Digging', 'Hauling spoil', 'Dumping spoil',
    'Tending brood', 'Approaching larva', 'Feeding larva', 'Moving brood',
    'Going to eat', 'Eating', 'Laying', 'Patrolling', 'Responding to alarm', 'Fighting', 'Resting',
    'Searching for water', 'Closing on water', 'Going to drink', 'Drinking',
    'Raiding a neighbour', 'Robbing their larder', 'Carrying off the spoils',
    'Backing away',
    'Looking for the dead', 'Going to a body', 'Carrying a body', 'Laying it out',
    'Collecting food for the queen', 'Taking food to the queen', 'Feeding the queen',
  ];

  // Per-ant event log codes
  AF.EV = [
    'emerged as an adult',       // 0
    'found a food source',       // 1
    'delivered food to the store', // 2
    'started a new tunnel face', // 3
    'dumped spoil on the mound', // 4
    'ate from the stores',       // 5
    'fed a larva',               // 6
    'moved brood to the nursery', // 7
    'attacked an intruder',      // 8
    'was wounded',               // 9
    'laid an egg',               // 10
    'lost the trail',            // 11
    'picked up a food trail',    // 12
    'broke through into a chamber', // 13
    'went hungry',               // 14
    'found water',               // 15
    'delivered water to the store', // 16
    'drank from the stores',     // 17
    'went thirsty',              // 18
    'switched to a new job',     // 19
    'robbed a rival larder',     // 20
    'backed away from a stranger', // 21
    'carried a body out',        // 22
    'brought home a stranger\'s body', // 23
    'broke into buried food',    // 24
    'turned back, low on water', // 25
    'fed the queen',             // 26
  ];
})();
