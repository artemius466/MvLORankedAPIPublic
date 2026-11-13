using UnityEngine;
using UnityEngine.Networking;
using System;
using System.Collections;
using System.Text;

namespace NSMB.Ranked.API {

    /// Transport layer. Every RankedAPIController call funnels through Send(),
    /// so auth, JSON, timeouts and error shaping are handled in exactly one
    /// place. Callers never touch UnityWebRequest directly.
    public class RankedAPIHelper {

        readonly string baseUrl;
        readonly Func<string> tokenProvider;

        public RankedAPIHelper(string baseUrl, Func<string> tokenProvider) {
            this.baseUrl = baseUrl.TrimEnd('/');
            this.tokenProvider = tokenProvider;
        }

        public IEnumerator Get<T>(string path, Action<T> onOk, Action<long, ApiError> onError)
            => Send("GET", path, null, onOk, onError);

        public IEnumerator Post<T>(string path, object body, Action<T> onOk, Action<long, ApiError> onError)
            => Send("POST", path, body, onOk, onError);

        IEnumerator Send<T>(string method, string path, object body,
                            Action<T> onOk, Action<long, ApiError> onError) {

            using (var req = new UnityWebRequest(baseUrl + path, method)) {
                req.downloadHandler = new DownloadHandlerBuffer();

                // /health and /login are the only endpoints usable without a
                // session, and SetRequestHeader rejects an empty value anyway.
                string token = tokenProvider != null ? tokenProvider() : null;
                if (!string.IsNullOrEmpty(token))
                    req.SetRequestHeader("Authorization", "Bearer " + token);

                if (body != null) {
                    string json = JsonUtility.ToJson(body);
                    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
                    req.SetRequestHeader("Content-Type", "application/json");
                }

                req.certificateHandler = new MvLCertificateHandler();
                req.disposeCertificateHandlerOnDispose = true;
                req.disposeDownloadHandlerOnDispose = true;
                req.disposeUploadHandlerOnDispose = true;

                // Matchmaking answers fast. A long hang means the connection is
                // gone, and retrying beats blocking the poll loop.
                req.timeout = 10;

                yield return req.SendWebRequest();

                string text = req.downloadHandler != null ? req.downloadHandler.text : null;

                if (req.result == UnityWebRequest.Result.Success) {
                    // /logout answers 204 with no body - there is nothing to parse.
                    if (string.IsNullOrWhiteSpace(text)) {
                        onOk?.Invoke(default(T));
                        yield break;
                    }

                    T parsed;
                    try {
                        parsed = JsonUtility.FromJson<T>(text);
                    } catch (Exception e) {
                        Debug.LogError($"[RANKED] bad JSON from {path}: {e.Message}\n{text}");
                        onError?.Invoke(0, null);
                        yield break;
                    }
                    onOk?.Invoke(parsed);
                    yield break;
                }

                // 4xx/5xx bodies are JSON: { "error": "...", "code": "..." }.
                // responseCode 0 means the request never landed (DNS, timeout,
                // no network) - those are the ones worth retrying.
                ApiError err = null;
                if (!string.IsNullOrEmpty(text)) {
                    try { err = JsonUtility.FromJson<ApiError>(text); } catch { /* not JSON */ }
                }

                Debug.LogWarning($"[RANKED] {method} {path} -> {req.responseCode} {err?.error ?? req.error}");
                onError?.Invoke(req.responseCode, err);
            }
        }
    }
}
