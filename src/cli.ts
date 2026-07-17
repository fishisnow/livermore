import { createInvestmentAgent } from "./agent/create-investment-agent.js";
import { loadConfig } from "./config.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: npm run dev -- "你的投资研究问题"');
  process.exitCode = 1;
} else {
  try {
    const config = loadConfig();
    const agent = await createInvestmentAgent(config);

    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    await agent.prompt(prompt);
    process.stdout.write("\n");

    if (agent.state.errorMessage) {
      throw new Error(agent.state.errorMessage);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
