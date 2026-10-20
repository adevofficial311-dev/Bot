# Deploying Yama Discord Bot & Web Dashboard to Render (24/7 Hosting)

Unlike Vercel (which is serverless and puts functions to sleep), **Render** runs a continuous Node.js server 24/7. This means **both the Web Dashboard and the 24/7 Discord Bot run together simultaneously** on Render! When you close your browser, your bot stays online 24/7.

---

## 🚀 1-Click Deployment to Render

1. **Download the Project ZIP**:
   - Go to the **Render Deploy** tab in your web dashboard and click **Download yama-discord-bot-render.zip**.
2. **Push to GitHub**:
   - Extract the ZIP and push the code to a GitHub repository.
3. **Deploy on Render**:
   - Go to [render.com](https://render.com) and click **New > Web Service**.
   - Connect your GitHub repository.
   - Render will automatically detect `render.yaml` and configure the build command (`npm install && npm run build`) and start command (`npm start`).
4. **Add Environment Variables**:
   - In Render dashboard, go to **Environment**, and add:
     - `DISCORD_TOKEN`: Your Discord bot token.
     - `OPENROUTER_API_KEY`: Your OpenRouter API key.
5. **Click Deploy Service**:
   - Render will build your web dashboard and launch your 24/7 Discord bot runner in the background!
