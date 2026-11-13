# Photon & Game Client Custom Authentication Guide

This guide explains how Photon Custom Server Authentication and the game client's `NSMB.Networking.AuthenticationHandler` work together with the MvLO Ranked API to authenticate players and enforce bans.

---

## 1. Overview & Architecture

The authentication and anti-cheat ban system operates across two cooperative layers:

```
[ NSMB Game Client (AuthenticationHandler.Authenticate) ]
        │
        │ 1. GET /auth/init?userid=...&token=...&args=...
        ▼
[ MvLO Ranked API (/auth/init) ]
        │
        ├── User is banned ───────────────► HTTP 403 { Id, Message: reason, Expiration: unixTimestamp }
        │                                       │
        │                                       ▼
        │                                 Unity deserializes BanMessage:
        │                                 Displays native in-game ban dialog:
        │                                 ui.error.gamebanned.temporary / permanent
        │                                 Stops connection! (returns null)
        │
        └── User valid & active ──────────► HTTP 200 "sessionToken"
                                                │
                                                ▼
                                          Unity strips quotes: result = sessionToken
                                          Sets: values.AddAuthParameter("data", result)
                                          Connects to Photon with AuthenticationValues
                                                │
                                                ▼
                                          [ Photon Cloud ]
                                                │
                                                │ 2. Webhook: GET/POST /api/auth/photon?photonToken=<token>&data=<token>
                                                ▼
                                        [ MvLO Ranked API (/auth/photon) ]
                                                │
                                                ├── Missing/Invalid photonToken ─► ResultCode: 3/2
                                                ├── Valid ──► ResultCode: 1, UserId: DiscordID, Data
                                                └── Banned ─► ResultCode: 2 ("You are banned...")
                                                │
                                                ▼
                                         [ Photon Cloud ]
                                                │
                                                ├── ResultCode 1: Connection accepted (UserId = DiscordID)
                                                └── ResultCode 2: Disconnected (CustomAuthFailed)
```

---

## 2. Setting Up `AuthenticationHandler.cs` in Unity

In your `NSMB.Networking.AuthenticationHandler` class:

1. **Update `URL`**: Point `URL` to your API's `/auth/init` endpoint:
   ```csharp
   // Local testing:
   private const string URL = "http://127.0.0.1:3000/auth/init";

   // Production:
   // private const string URL = "https://your-api-domain.com/auth/init";
   ```
   *(Note: Both `/auth/init` and `/api/auth/init` are supported).*

2. **How `Authenticate()` Works With the API**:
   - `Authenticate()` reads `id` and `token` from `PlayerPrefs`:
     ```csharp
     string userid = PlayerPrefs.GetString("id", null);
     string token = PlayerPrefs.GetString("token", null);
     ```
   - Sends a `GET` request to `/auth/init?userid={userid}&token={token}&args={args}`.
   - **If the player is banned**:
     The server responds with **HTTP 403** and the exact `BanMessage` payload expected by Unity:
     ```json
     {
       "Id": 1,
       "Message": "Caught hacking / illegal memory modification",
       "Expiration": 1789364631
     }
     ```
     `Expiration` is a 64-bit Unix timestamp in seconds (or `null` if permanent).
     Unity deserializes `BanMessage ban = JsonConvert.DeserializeObject<BanMessage>(result)` and displays:
     - `ui.error.gamebanned.temporary` when `Expiration` has a value.
     - `ui.error.gamebanned.permanent` when `Expiration` is null.
     The method stops and returns `null`, preventing the client from attempting a Photon connection.
   - **If the player is not banned and authenticated**:
     The server responds with **HTTP 200** containing the session token:
     `"aq38f..."`
     Unity's quote-stripping loop runs:
     ```csharp
     string result = webRequest.downloadHandler.text.Trim();
     while (result.StartsWith('"')) { result = result[1..]; }
     while (result.EndsWith('"')) { result = result[..^1]; }
     ```
     And packages the token for Photon:
     ```csharp
     AuthenticationValues values = new() {
         AuthType = CustomAuthenticationType.Custom,
         UserId = userid,
     };
     values.AddAuthParameter("data", result);

     IsAuthenticating = false;
     return values;
     ```

---

## 3. Configuring the Photon Dashboard

1. Log into your [Photon Engine Dashboard](https://dashboard.photonengine.com/).
2. Select your Application (PUN / Realtime / Fusion) and click **Manage**.
3. Under **Custom Authentication**, click **Create a new authentication provider**:
   - **Authentication Type**: `Custom`
   - **Authentication URL**:
     ```
     https://your-api-domain.com/api/auth/photon
     ```
     *(Both `/auth/photon` and `/api/auth/photon` are supported).*
   - **Key/Value pairs (query string)**:
     ```
     photonToken=<YOUR_PHOTON_TOKEN>
     ```
     *(Must match `PHOTON_TOKEN` configured in your `.env`. Alternatively, append `?photonToken=<YOUR_PHOTON_TOKEN>` directly to the Authentication URL).*
   - **Reject anonymous clients**: **Check this box (Enabled)**.
4. Click **Save**.

---

## 4. How Photon Custom Authentication Validates the Token

When Unity connects to Photon with the `AuthenticationValues` returned by `AuthenticationHandler.Authenticate()`:

1. Photon Cloud receives `values.AddAuthParameter("data", result)`.
2. Photon Cloud calls your Authentication URL with `?photonToken=<token>&data=<sessionToken>&userId=<userid>`.
3. Our server first validates the `photonToken` against `PHOTON_TOKEN` in `.env`:
   - **If `photonToken` is missing**: returns `{ "ResultCode": 3, "Message": "Missing photonToken parameter." }`.
   - **If `photonToken` is invalid**: returns `{ "ResultCode": 2, "Message": "Invalid photonToken." }`.
4. Our server extracts the user's session token from `data` (or `token`), validates the session in PostgreSQL, and re-checks ban status:
   - **If Banned**:
     Returns:
     ```json
     {
       "ResultCode": 2,
       "Message": "You are banned from playing.\nReason: ...\nTime left: ... hours."
     }
     ```
     Photon Cloud immediately rejects the connection. Even if a user modified their client to bypass `AuthenticationHandler.Authenticate()`, Photon's server-side auth blocks them.
   - **If Valid & Active**:
     Returns:
     ```json
     {
       "ResultCode": 1,
       "UserId": "123456789012345678",
       "Nickname": "MarioMaster",
       "Data": {
         "elo": 1250,
         "username": "mariomaster",
         "displayName": "MarioMaster"
       }
     }
     ```
     Photon Cloud **enforces and overrides** the client's `UserId` with the verified Discord ID from the database, preventing identity and rating spoofing.

---

## 5. Development Build Backdoor

In development builds (`RankedAPIController.IsDevelopmentBuild == true`), `AuthenticationHandler` skips passing `userid` and `token`.

When `devLoginEnabled` is active on the server (`NODE_ENV !== 'production'`), `/auth/init` automatically handles this:
- Mints or fetches a dev user session (`dev_user_1`).
- Returns a valid session token directly to Unity.
- Allows developers to test multiplayer in the Unity Editor without manually completing Discord OAuth each time.
