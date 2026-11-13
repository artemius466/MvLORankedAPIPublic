using System;

namespace NSMB.Ranked.API {

    // Mirrors frontend/js/tiers.js so the client can show a rank without an
    // API round trip. Keep the two in sync if the ladder ever changes.

    [Serializable]
    public struct RankInfo {
        public string tier;   // e.g. "Shell"
        public int division;  // 1-3
        public string label;  // e.g. "Shell 2"
        public int progressPct; // 0-99, how far through the division
        public string next;     // label of the next division/tier, or "the top of the ladder"
    }

    public static class RankedTiers {

        // (floor elo, tier name), ascending. The last band has no successor,
        // so it's given a nominal span instead of a real ceiling.
        static readonly (int Floor, string Name)[] Bands = {
            (0,    "Mini"),
            (350,  "Mushroom"),
            (650,  "Shell"),
            (950,  "Fireflower"),
            (1200, "Star"),
        };

        const int TopBandSpan = 300;
        const int Divisions = 3;

        /// Ratings are floored here too, so an elo below the lowest band still
        /// resolves to Mini 1 instead of throwing.
        public static RankInfo TierFor(int elo) {
            int idx = 0;
            for (int i = 0; i < Bands.Length; i++) {
                if (elo >= Bands[i].Floor) idx = i;
            }

            string name = Bands[idx].Name;
            int lo = Bands[idx].Floor;
            int hi = idx + 1 < Bands.Length ? Bands[idx + 1].Floor : lo + TopBandSpan;

            double frac = Math.Max(0.0, Math.Min(0.999, (double) (elo - lo) / (hi - lo)));
            int division = (int) (frac * Divisions) + 1;
            int progressPct = (int) Math.Round((frac * Divisions) % 1.0 * 100.0);

            string next;
            if (division < Divisions) {
                next = name + " " + (division + 1);
            } else if (idx + 1 < Bands.Length) {
                next = Bands[idx + 1].Name + " 1";
            } else {
                next = "the top of the ladder";
            }

            return new RankInfo {
                tier = name,
                division = division,
                label = name + " " + division,
                progressPct = progressPct,
                next = next,
            };
        }
    }
}
