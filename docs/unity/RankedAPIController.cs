using UnityEngine;
using UnityEngine.Networking;
using System;
using System.Collections;

namespace NSMB.Ranked.API {

    public static class RankedSession {
        public static string Token = string.Empty;
        public static string LoginState = string.Empty;
        public static UserProfile Profile;

        public static bool IsAuthenticated => !string.IsNullOrEmpty(Token);

        public static void Clear() {
            Token = string.Empty;
            LoginState = string.Empty;
            Profile = null;
        }
    }

    /// Every endpoint the API exposes, one method each, all routed through
    /// RankedAPIHelper. Each returns an IEnumerator, so callers drive them with
    /// StartCoroutine(...) - or `yield return` them from their own coroutine.
    ///
    ///   StartCoroutine(RankedAPIController.PollQueue(pings, maxPing, OnPoll, OnError));
    ///
    /// The only endpoint missing is GET /api/callback: Discord redirects a
    /// browser there, the game client never calls it.
    public static class RankedAPIController {

        public const string ApiBase = "http://127.0.0.1:3000/api";

        /// How long ProcessLoginFlow waits for the browser round trip.
        const float LoginTimeoutSeconds = 300f;
        const float LoginPollSeconds = 3f;

        /// Recommended matchmaking poll interval. The server drops a queue
        /// ticket after 15s without a poll, so do not go far above this.
        public const float MatchmakingPollSeconds = 2f;

        static readonly RankedAPIHelper Api = new RankedAPIHelper(ApiBase, () => RankedSession.Token);

        // ============================================================ system

        /// GET /api/health
        public static IEnumerator Health(Action<HealthResponse> onOk = null,
                                         Action<long, ApiError> onError = null)
            => Api.Get<HealthResponse>("/health", onOk, onError);

        // ============================================================== auth

        /// GET /api/login - returns the Discord URL to open and stashes the
        /// state that ProcessLoginFlow will poll with.
        public static IEnumerator Login(Action<LoginResponse> onOk = null,
                                        Action<long, ApiError> onError = null)
            => Api.Get<LoginResponse>("/login",
                res => {
                    if (res != null) RankedSession.LoginState = res.state;
                    onOk?.Invoke(res);
                },
                onError);

        /// GET /api/login/poll - single use: the first "complete" consumes it,
        /// every later poll answers "pending" forever. ProcessLoginFlow below
        /// is the loop you normally want.
        public static IEnumerator LoginPoll(Action<LoginPollResponse> onOk = null,
                                            Action<long, ApiError> onError = null)
            => Api.Get<LoginPollResponse>(
                $"/login/poll?state={UnityWebRequest.EscapeURL(RankedSession.LoginState)}", onOk, onError);

        /// Polls /login/poll until the browser round trip finishes, then stores
        /// the token and profile on RankedSession. Call Login() first and open
        /// its url. onFail receives the server's error string, or "timeout".
        public static IEnumerator ProcessLoginFlow(Action<string> onSuccess = null,
                                                   Action<string> onFail = null) {
            float elapsed = 0f;

            while (elapsed < LoginTimeoutSeconds) {
                yield return new WaitForSeconds(LoginPollSeconds);
                elapsed += LoginPollSeconds;

                LoginPollResponse poll = null;
                yield return LoginPoll(res => poll = res, (code, err) => poll = null);

                // Transport blip: keep trying until the overall timeout.
                if (poll == null) {
                    Debug.LogWarning("[RANKED] Network error while polling login.");
                    continue;
                }

                if (poll.status == "pending") continue;

                if (poll.status == "error") {
                    Debug.LogWarning("[RANKED] Login failed: " + poll.error);
                    onFail?.Invoke(poll.error);
                    yield break;
                }

                // status == "complete"
                RankedSession.Token = poll.token;
                RankedSession.Profile = poll.user;
                Debug.Log("[RANKED] Logged in as " + (poll.user != null ? poll.user.displayName : "?"));
                onSuccess?.Invoke(poll.token);
                yield break;
            }

            Debug.LogWarning("[RANKED] Login timed out.");
            onFail?.Invoke("timeout");
        }

        /// GET /api/me - the cached profile, no Discord round trip.
        public static IEnumerator GetUserInfo(Action<MeResponse> onOk = null,
                                              Action<long, ApiError> onError = null)
            => Api.Get<MeResponse>("/me",
                res => {
                    if (res != null) RankedSession.Profile = res.user;
                    onOk?.Invoke(res);
                },
                onError);

        /// POST /api/refresh - safe to call on every launch; it only actually
        /// hits Discord once the cached profile is stale.
        public static IEnumerator RefreshProfile(Action<RefreshResponse> onOk = null,
                                                 Action<long, ApiError> onError = null)
            => Api.Post<RefreshResponse>("/refresh", null,
                res => {
                    if (res != null && res.user != null) RankedSession.Profile = res.user;
                    onOk?.Invoke(res);
                },
                onError);

        /// POST /api/logout - answers 204, and clears the local session.
        public static IEnumerator Logout(Action onOk = null,
                                         Action<long, ApiError> onError = null)
            => Api.Post<EmptyResponse>("/logout", null,
                _ => {
                    RankedSession.Clear();
                    onOk?.Invoke();
                },
                onError);

        /// GET /api/auth/photon?token=...&photonToken=...
        /// Direct client test/preflight for Photon Custom Authentication.
        /// Useful if testing or validating session/ban status directly.
        public static IEnumerator AuthenticatePhoton(string token = null,
                                                     string photonToken = null,
                                                     Action<PhotonAuthResponse> onOk = null,
                                                     Action<long, ApiError> onError = null) {
            string t = !string.IsNullOrEmpty(token) ? token : RankedSession.Token;
            string url = $"/auth/photon?token={UnityWebRequest.EscapeURL(t ?? string.Empty)}";
            if (!string.IsNullOrEmpty(photonToken)) {
                url += $"&photonToken={UnityWebRequest.EscapeURL(photonToken)}";
            }
            return Api.Get<PhotonAuthResponse>(
                url,
                onOk,
                onError);
        }

        // =========================================================== history

        /// GET /api/users/{id}/matches - public, no session needed.
        public static IEnumerator GetMatchHistory(string userId, int limit = 50,
                                                  Action<MatchHistoryResponse> onOk = null,
                                                  Action<long, ApiError> onError = null)
            => Api.Get<MatchHistoryResponse>(
                $"/users/{UnityWebRequest.EscapeURL(userId)}/matches?limit={Mathf.Clamp(limit, 1, 50)}",
                onOk, onError);

        // ======================================================= matchmaking

        /// GET /api/matchmaking/estimate - no session needed, so this is safe
        /// to call before logging in. `estimate` is a ready-to-display string.
        /// Maps no longer affect it - nothing is chosen before queuing anymore.
        public static IEnumerator GetEstimatedWaitTime(Action<EstimateResponse> onOk = null,
                                                        Action<long, ApiError> onError = null)
            => Api.Get<EstimateResponse>("/matchmaking/estimate", onOk, onError);

        /// GET /api/matchmaking/maps - no session needed. The full map pool a
        /// match can be played on - only actually useful for showing the veto
        /// UI ahead of time, since RankedMaps.All already mirrors the same ids.
        public static IEnumerator GetMapPool(Action<MapsResponse> onOk = null,
                                             Action<long, ApiError> onError = null)
            => Api.Get<MapsResponse>("/matchmaking/maps", onOk, onError);

        /// POST /api/matchmaking/queue - endpoint 1. Answers "searching", or
        /// straight away "found" if a compatible opponent was already waiting.
        public static IEnumerator StartMatchmaking(QueueRequest body,
                                                   Action<QueuePollResponse> onOk = null,
                                                   Action<long, ApiError> onError = null)
            => Api.Post<QueuePollResponse>("/matchmaking/queue", body, onOk, onError);

        /// `pings` is positional by region - see RankedRegions.All - and
        /// should have one entry per region every time it's sent at all; a
        /// region left out clamps to the worst possible reading for it, same
        /// as ClampPing() does for any individual out-of-range value.
        public static IEnumerator StartMatchmaking(int[] pings, int maxPing,
                                                   Action<QueuePollResponse> onOk = null,
                                                   Action<long, ApiError> onError = null)
            => StartMatchmaking(new QueueRequest {
                pings = ClampPings(pings),
                maxPing = ClampPing(maxPing)
            }, onOk, onError);

        /// GET /api/matchmaking/poll - endpoint 2. searching | found | idle.
        public static IEnumerator PollQueue(int[] pings, int maxPing,
                                            Action<QueuePollResponse> onOk = null,
                                            Action<long, ApiError> onError = null)
            => Api.Get<QueuePollResponse>(
                $"/matchmaking/poll?pings={PingsQueryString(pings)}&maxPing={ClampPing(maxPing)}", onOk, onError);

        /// POST /api/matchmaking/accept - endpoint 3.
        public static IEnumerator AcceptMatch(Action<MatchPollResponse> onOk = null,
                                              Action<long, ApiError> onError = null)
            => Api.Post<MatchPollResponse>("/matchmaking/accept", null, onOk, onError);

        /// POST /api/matchmaking/decline - endpoint 4. Also drops you out of
        /// the queue; the opponent is requeued automatically.
        public static IEnumerator DeclineMatch(Action<MatchPollResponse> onOk = null,
                                               Action<long, ApiError> onError = null)
            => Api.Post<MatchPollResponse>("/matchmaking/decline", null, onOk, onError);

        /// GET /api/matchmaking/match - endpoint 5. waiting | ready | ended |
        /// none. Usable from the moment a match is found, before you answer.
        /// The match's region is already fixed by the time this matters, but
        /// keep sending readings anyway - MatchInfo.opponent.ping reflects
        /// whatever your ticket's reading is for it.
        public static IEnumerator PollMatch(int[] pings, int maxPing,
                                            Action<MatchPollResponse> onOk = null,
                                            Action<long, ApiError> onError = null)
            => Api.Get<MatchPollResponse>(
                $"/matchmaking/match?pings={PingsQueryString(pings)}&maxPing={ClampPing(maxPing)}", onOk, onError);

        /// POST /api/matchmaking/ban - endpoint 6, the map veto. Only valid on
        /// your turn - see MatchPollResponse.mapVeto.yourTurn - and mapId must
        /// be one of mapVeto.remainingMaps. 403 not_your_turn otherwise.
        public static IEnumerator BanMap(string mapId,
                                         Action<MatchPollResponse> onOk = null,
                                         Action<long, ApiError> onError = null)
            => Api.Post<MatchPollResponse>("/matchmaking/ban",
                new BanMapRequest { mapId = mapId }, onOk, onError);

        /// POST /api/matchmaking/room - endpoint 7. Host only, once the map
        /// veto has settled (MatchPollResponse.match.map != null); the guest
        /// gets 403 not_host, and the host itself gets 409 map_not_decided if
        /// called too early.
        public static IEnumerator PublishRoomCode(string roomCode,
                                                  Action<MatchPollResponse> onOk = null,
                                                  Action<long, ApiError> onError = null)
            => Api.Post<MatchPollResponse>("/matchmaking/room",
                new RoomRequest { roomCode = roomCode }, onOk, onError);

        /// POST /api/matchmaking/cancel - endpoint 9. Safe to call when there
        /// is nothing to cancel, so it can be wired to a back button.
        public static IEnumerator CancelMatchmaking(Action<CancelResponse> onOk = null,
                                                    Action<long, ApiError> onError = null)
            => Api.Post<CancelResponse>("/matchmaking/cancel", null, onOk, onError);

        // ============================================================= utils

        /// The server clamps to this range anyway; doing it here keeps a bad
        /// reading from turning into a nonsense query string.
        static int ClampPing(int ping) => Mathf.Clamp(ping, 0, 5000);

        static int[] ClampPings(int[] pings) {
            var clamped = new int[pings?.Length ?? 0];
            for (int i = 0; i < clamped.Length; i++) clamped[i] = ClampPing(pings[i]);
            return clamped;
        }

        /// Comma-separated, positional by region.
        static string PingsQueryString(int[] pings) =>
            string.Join(",", Array.ConvertAll(ClampPings(pings), p => p.ToString()));
    }
}
