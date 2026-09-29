# UniWallet as an Android app (APK)

The React app is wrapped with Capacitor. The APK contains the frontend only;
it talks to the FastAPI backend running on your PC, so the phone and the PC
must be on the same Wi-Fi.

## One-time setup
1. Install **Android Studio** (it brings the Android SDK and a JDK).
2. Find your PC's Wi-Fi IPv4 address (`ipconfig`), e.g. `192.168.1.20`.
3. Create `mintly-react/.env.production.local` (git-ignored) containing:
   `VITE_API_BASE_URL=http://192.168.1.20:4000`
4. In the backend `.env`, allow the app's origin:
   `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost`
5. Allow port 4000 through Windows Firewall (Private networks).

## Build the APK
```powershell
cd mintly-react
npm install
npm run android:sync        # builds the web app and copies it into android/
npm run android:open        # opens Android Studio
```
In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
The file is `android/app/build/outputs/apk/debug/app-debug.apk`.
(With the SDK set up you can also run `npm run android:apk` from PowerShell.)

## Install on the phone
Copy `app-debug.apk` to the phone (USB, Drive, WhatsApp to yourself), open it,
and allow "Install unknown apps" when asked. Or plug the phone in with USB
debugging on and press Run in Android Studio.

## Every time you use it
Start the backend so the phone can reach it:
```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 4000
```
If your PC's IP changes, repeat steps 3 and `npm run android:sync`, then rebuild.
