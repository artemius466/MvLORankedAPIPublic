// Display names for stage ids. Mirrors src/domain/matches.js
// MAP_DISPLAY_NAMES/displayNameForStage - kept in sync by hand since there is
// no endpoint that just returns the name lookup on its own (same situation as
// matchmaking-test.js's MAPS list).
"use strict";
(function () {
  const MAP_DISPLAY_NAMES = {
    defaultgrassstage: "Grassland",
    customjunglestage: "Jungle",
    defaultbricksstage: "Brick",
    customskymap: "Sky",
    custombonusmap: "Bonus",
    defaultfortressmap: "Fortress",
    defaultpipesmap: "Pipes",
    customvolcanomap: "Volcano",
    customdesertmap: "Desert",
    defaulticestage: "Ice",
    custombeachmap: "Beach",
    customghosthousemap: "Ghost House",
  };

  function displayName(stageId) {
    const base = String(stageId).replace(/^\d+/, "");
    return MAP_DISPLAY_NAMES[base] || stageId;
  }

  window.MvLOMaps = { MAP_DISPLAY_NAMES, displayName };
})();
