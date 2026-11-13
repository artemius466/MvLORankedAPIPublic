using System;

namespace NSMB.Ranked.API {

    // Naming standard used throughout:
    //   <Thing>Info / <Thing>Profile / <Thing>Entry  - models reused across responses
    //   <Endpoint>Response                           - the body of one endpoint
    //   <Endpoint>Request                            - a POST body
    //
    // JsonUtility needs public fields named exactly as the JSON, and silently
    // ignores anything the response does not contain - so one class can cover
    // several shapes of the same endpoint (see MatchPollResponse).

    // ---------------------------------------------------------------- models

    [Serializable]
    public class UserProfile {
        public string id;               // Discord snowflake
        public string username;
        public string displayName;
        public string avatarUrl;
        public int elo;
        public string refreshedAt;      // ISO-8601
        public string createdAt;        // ISO-8601
    }

    [Serializable]
    public class LeaderboardEntry {
        public string id;               // Discord snowflake
        public string username;
        public string displayName;
        public string avatarUrl;
        public int elo;
        public string refreshedAt;      // ISO-8601
        public string createdAt;        // ISO-8601
        public bool online;
    }

    /// A map: a stable id plus the name to show the player.
    [Serializable]
    public class NamedId {
        public string id;
        public string name;
    }

    /// A region: an index (matches the position in QueueInfo.pings /
    /// QueueRequest.pings) plus the name to show the player. Never chosen by
    /// the client - see RankedRegions.All below, the client-side mirror of
    /// the same list the server derives MatchInfo.region from.
    [Serializable]
    public class RegionInfo {
        public int id;
        public string name;
    }

    [Serializable]
    public class PlayerInfo {
        public string id;               // Discord snowflake
        public string username;
        public string displayName;
        public string avatarUrl;
        public int elo;
        public int ping;                // opponent's ping for MatchInfo.region, not their best/latest overall
    }

    /// Elo multipliers, sent only once both sides have accepted. Both are 1 on
    /// an even match; otherwise the underdog wins more and loses less.
    ///
    /// Relative to this match's own average swing, not to any fixed number of
    /// points - the pair always averages 1. They describe how the match is
    /// tilted, never how big it is: ratings are Glicko-2, so an unplaced
    /// player's match moves them much further than a settled player's
    /// regardless of who is favoured.
    [Serializable]
    public class EloStake {
        public float winMultiplier;
        public float lossMultiplier;
        public bool favoured;           // true when the stakes are tilted your way
    }

    /// Everything the pre-game screens need. Identical on both polls.
    ///
    /// `opponent`/`eloStake`/`eloDifference`/`outsideBaseRange` are the
    /// opponent reveal: the API leaves them out of the payload entirely while
    /// the match is still being accepted, so neither side can answer the
    /// prompt based on who they drew. `map` is left out for a different
    /// reason - it isn't decided yet at all until the map veto (see
    /// MapVetoInfo below) finishes, which only starts once both sides have
    /// accepted. JsonUtility gives you null/0/false for all of these until
    /// they're actually present - check `opponent != null` / `map != null`
    /// rather than the poll status if you want one test that covers both
    /// polls.
    [Serializable]
    public class MatchInfo {
        public string matchId;
        public NamedId map;             // null until the map veto (MapVetoInfo) decides one
        public RegionInfo region;       // present from "found"/"waiting" on - never withheld
        public int expiresInSeconds;
        public PlayerInfo opponent;     // ready onwards; null while pending
        public EloStake eloStake;       // ready onwards; null while pending
        public int eloDifference;       // ready onwards; 0 while pending
        public bool outsideBaseRange;   // ready onwards; false while pending
    }

    /// CS2-style map veto, shown on MatchPollResponse while `status == "ready"`
    /// and MatchInfo.map is still null. The host bans two maps, then the guest
    /// bans one - see RankedAPIController.BanMap - leaving one map standing,
    /// which then shows up as MatchInfo.map and this goes back to null.
    [Serializable]
    public class MapVetoInfo {
        public string turn;             // "host" | "guest" | null once decided
        public bool yourTurn;           // convenience: turn == "host" && isHost, or turn == "guest" && !isHost
        public NamedId[] remainingMaps; // not yet banned, in the original pool's order
        public NamedId[] bannedMaps;    // banned so far, in ban order
    }

    [Serializable]
    public class QueueInfo {
        public int[] pings;             // one reading per region, positional by RegionInfo.id
        public int maxPing;
        public int elo;
        public int waitedSeconds;
        public int eloRange;
        // null once the band has hit its cap; JsonUtility gives you 0 there.
        public int nextExpansionInSeconds;
    }

    /// How the previous match ended. Delivered by exactly one poll, then gone.
    [Serializable]
    public class LastMatchInfo {
        public string matchId;
        public string reason;           // see RankedEndReasons
        public bool requeued;           // true: you are already searching again
    }

    [Serializable]
    public class MatchHistoryEntry {
        public string id;               // bigint -> arrives as a STRING, not a number
        public string opponentId;
        public string opponentName;
        public string stage;
        public int eloDelta;
        public string replayUrl;
        public string playedAt;         // ISO-8601
    }

    // ------------------------------------------------------------- responses

    /// GET /api/health
    [Serializable]
    public class HealthResponse {
        public bool ok;
    }

    /// GET /api/login
    [Serializable]
    public class LoginResponse {
        public string url;              // open this in the system browser
        public string state;            // then poll /login/poll with it
    }

    /// GET /api/login/poll - status: pending | complete | error
    [Serializable]
    public class LoginPollResponse {
        public string status;
        public string token;            // status == "complete"
        public string error;            // status == "error"
        public UserProfile user;        // status == "complete"
    }

    [Serializable]
    public class PhotonAuthData {
        public int elo;
        public string username;
        public string displayName;
    }

    /// GET or POST /api/auth/photon - standard Photon Custom Authentication format
    [Serializable]
    public class PhotonAuthResponse {
        public int ResultCode;          // 1: Success, 2: Auth failed / Banned, 3: Invalid params
        public string UserId;           // Discord snowflake
        public string Nickname;
        public string Message;          // Error or ban explanation if ResultCode != 1
        public PhotonAuthData Data;
    }

    /// GET /api/me
    [Serializable]
    public class MeResponse {
        public UserProfile user;
    }

    /// POST /api/refresh
    [Serializable]
    public class RefreshResponse {
        public UserProfile user;
        public bool refreshed;
        public int refreshIntervalMinutes;
        public string warning;          // e.g. discord_access_revoked
    }

    /// GET /api/users/{id}/matches
    [Serializable]
    public class MatchHistoryResponse {
        public MatchHistoryEntry[] matches;
    }

    /// GET /api/leaderboard?limit=..&offset=.. - no session needed. Players are
    /// sorted by elo. offset pages through the ranking (default 0).
    [Serializable]
    public class LeaderboardResponse {
        public int total;               // how many ranked players exist in total
        public LeaderboardEntry[] players;
    }

    /// GET /api/matchmaking/estimate - no session needed. `estimate` is a
    /// ready-to-display string, not structured data - either "Estimated time:
    /// MM:SS" or "Currently no one is queueing" if the queue is empty.
    [Serializable]
    public class EstimateResponse {
        public string estimate;
    }

    /// GET /api/matchmaking/maps - no session needed. The full map pool a
    /// match can be played on - what the veto (MapVetoInfo) bans down from.
    [Serializable]
    public class MapsResponse {
        public NamedId[] maps;
    }

    /// GET /api/matchmaking/poll - status: searching | found | idle
    [Serializable]
    public class QueuePollResponse {
        public string status;
        public QueueInfo queue;         // status == "searching"
        public MatchInfo match;         // status == "found"
        public string response;         // your answer so far: "pending" / "accepted"
        public LastMatchInfo lastMatch; // one-shot, on any status
    }

    /// GET /api/matchmaking/match - status: waiting | ready | ended | none
    [Serializable]
    public class MatchPollResponse {
        public string status;
        public MatchInfo match;         // waiting | ready
        public bool accepted;           // waiting - false while the prompt is up
        public bool opponentAccepted;   // waiting
        public bool isHost;             // ready  - never decide this locally
        public string hostId;           // ready
        // ready - null until the map veto (mapVeto) settles AND the host
        // publishes it; the two are independent, but the host cannot publish
        // until match.map is decided (see RankedAPIController.PublishRoomCode).
        public string roomCode;
        // ready, only while match.map is still null - gone (JsonUtility gives
        // you null) the instant the veto settles, since match.map has the
        // answer at that point.
        public MapVetoInfo mapVeto;

        // status == "ended"
        public string matchId;
        public string reason;           // see RankedEndReasons
        public bool requeued;
    }

    /// POST /api/matchmaking/cancel
    [Serializable]
    public class CancelResponse {
        public bool ok;
        public bool left;               // false just means there was nothing to cancel
    }

    /// Endpoints that answer 204 with no body (e.g. /logout).
    [Serializable]
    public class EmptyResponse { }

    /// Any 4xx/5xx body.
    [Serializable]
    public class ApiError {
        public string error;
        public string code;             // e.g. not_host, match_in_progress, not_your_turn
    }

    // -------------------------------------------------------------- requests

    /// POST /api/matchmaking/queue - no maps anymore; see MapVetoInfo instead.
    [Serializable]
    public class QueueRequest {
        public int[] pings;             // one reading per region, positional - see RankedRegions.All
        public int maxPing;
    }

    /// POST /api/matchmaking/room
    [Serializable]
    public class RoomRequest {
        public string roomCode;
    }

    /// POST /api/matchmaking/ban - the map veto. Only valid on your turn (see
    /// MatchPollResponse.mapVeto.yourTurn); mapId must be one of
    /// mapVeto.remainingMaps.
    [Serializable]
    public class BanMapRequest {
        public string mapId;
    }

    // ------------------------------------------------------------- constants

    public static class RankedMaps {
        public const string Grassland = "defaultgrassstage";
        public const string Jungle    = "customjunglestage";
        public const string Brick     = "defaultbricksstage";
        public const string Desert    = "customdesertmap";

        public static readonly string[] All = {
            Grassland, Jungle, Brick, Desert
        };
    }

    /// Mirrors matches.REGION_DISPLAY_NAMES server-side - kept in sync by
    /// hand, same as RankedMaps above, since there is no endpoint that
    /// returns this list on its own (see docs/matchmaking.md's Valid ids).
    /// Index order matters: it's the same order QueueInfo.pings /
    /// QueueRequest.pings are positional by.
    public static class RankedRegions {
        public const int Asia            = 0;
        public const int Australia       = 1;
        public const int CanadaEast      = 2;
        public const int Europe          = 3;
        public const int HongKong        = 4;
        public const int India           = 5;
        public const int Japan           = 6;
        public const int SouthKorea      = 7;
        public const int Russia          = 8;
        public const int SouthAmerica    = 9;
        public const int Turkey          = 10;
        public const int Uae             = 11;
        public const int UsEast          = 12;
        public const int UsSouthCentral  = 13;
        public const int UsWest          = 14;
        public const int SouthAfrica     = 15;

        public static readonly RegionInfo[] All = {
            new RegionInfo { id = Asia,           name = "🇸🇬 Asia" },
            new RegionInfo { id = Australia,      name = "🇦🇺 Australia" },
            new RegionInfo { id = CanadaEast,     name = "🇨🇦 Canada, East" },
            new RegionInfo { id = Europe,         name = "🇪🇺 Europe" },
            new RegionInfo { id = HongKong,       name = "🇭🇰 Hong Kong" },
            new RegionInfo { id = India,          name = "🇮🇳 India" },
            new RegionInfo { id = Japan,          name = "🇯🇵 Japan" },
            new RegionInfo { id = SouthKorea,     name = "🇰🇷 South Korea" },
            new RegionInfo { id = Russia,         name = "🇷🇺 Russia" },
            new RegionInfo { id = SouthAmerica,   name = "🇧🇷 South America" },
            new RegionInfo { id = Turkey,         name = "🇹🇷 Turkey" },
            new RegionInfo { id = Uae,            name = "🇦🇪 United Arab Emirates" },
            new RegionInfo { id = UsEast,         name = "🇺🇸 USA, East" },
            new RegionInfo { id = UsSouthCentral, name = "🇺🇸 USA, South Central" },
            new RegionInfo { id = UsWest,         name = "🇺🇸 USA, West" },
            new RegionInfo { id = SouthAfrica,    name = "🇿🇦 South Africa" },
        };
    }

    /// Values of LastMatchInfo.reason / MatchPollResponse.reason. The
    /// un-prefixed ones mean you caused it.
    public static class RankedEndReasons {
        public const string Declined         = "declined";
        public const string OpponentDeclined = "opponent_declined";
        public const string Timeout          = "timeout";
        public const string OpponentTimeout  = "opponent_timeout";
        public const string Left             = "left";
        public const string OpponentLeft     = "opponent_left";
        public const string Expired          = "expired";
    }

    /// Values of ApiError.code.
    public static class RankedErrorCodes {
        public const string MatchInProgress   = "match_in_progress";
        public const string AlreadyQueued     = "already_queued";
        public const string NoPendingMatch    = "no_pending_match";
        public const string NoReadyMatch      = "no_ready_match";
        public const string NotHost           = "not_host";
        public const string InvalidRoomCode   = "invalid_room_code";
        public const string MapNotDecided     = "map_not_decided";     // /room called before the veto settled
        public const string NotYourTurn       = "not_your_turn";       // /ban called out of turn
        public const string UnknownMap        = "unknown_map";         // /ban with an id not in RankedMaps.All
        public const string MapAlreadyBanned  = "map_already_banned";  // /ban on a map that's gone already
        public const string MapAlreadyDecided = "map_already_decided"; // /ban after the veto already finished
        public const string NoMapsLeft        = "no_maps_left";        // /ban would leave nothing to play on
    }
}
