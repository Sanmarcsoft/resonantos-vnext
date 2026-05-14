// Intent citation: docs/architecture/ADR-016-haus-vm-hermes-replacement.md
// Intent citation: openui-fork memory (Sanmarcsoft/openui, parent thesysdev/openui)
//
// "Hello Zorin native" spike. Uses @openuidev/react-ui's FullScreen chat
// surface natively inside the resonantos-vnext shell — no iframe to
// haus.matthewstevens.org. The point of the spike is to prove the
// integration shape, not to ship working chat:
//
// - Bundling: pnpm/npm file-linked @openuidev packages compile against
//   the Vite + React 19 toolchain that resonantos-vnext already uses.
// - Types: @openuidev/react-ui ships its own TypeScript types and they
//   line up with React 19 in this repo.
// - Render: FullScreen mounts inside a workspace panel without breaking
//   the rest of the shell.
//
// What is STUBBED in this spike (each becomes its own follow-up commit):
//
//   1. Real chat path. processMessage below returns a synthesised SSE
//      response so FullScreen has something to consume. The actual
//      /api/widget/chat endpoint is single-JSON, not streaming, and
//      reaching it from a Tauri origin crosses CORS. Both are solved by
//      either adding SSE to widget-bridge or routing the call through
//      Tauri's HTTP plugin in src-tauri. Track in ADR-029.
//   2. Zorin persona inside generative-UI. The chat library here is the
//      OpenUI default ("openui-chat") component lib. Zorin's coaching
//      surfaces (DRIP matrix, 10X Vision board, daily-rocks dashboard)
//      need their own component library declared via genui-lib.
//   3. Provider routing. Real chat must flow through the existing
//      provider fabric (model strategy + delegation) rather than direct
//      to haus-vm. The spike does not call any model.

import "@openuidev/react-ui/components.css";
import { openAIAdapter } from "@openuidev/react-headless";
import { FullScreen } from "@openuidev/react-ui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";

function fakeStream(text: string): Response {
  // Minimal OpenAI-compatible SSE so openAIAdapter() can parse and emit
  // a single assistant turn. Frees the spike from needing the real
  // widget-bridge to stream.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = [
        { choices: [{ delta: { role: "assistant", content: text } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ];
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SPIKE_REPLY =
  "Mister Stevens. The native shell receives me. The iframe was a holding pattern; this is the chassis. The streaming path and the provider routing remain to be wired. Out.";

export function ZorinNative() {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <FullScreen
        agentName="Zorin"
        componentLibrary={openuiChatLibrary}
        streamProtocol={openAIAdapter()}
        processMessage={async () => fakeStream(SPIKE_REPLY)}
        conversationStarters={{
          variant: "short",
          options: [
            { displayText: "DRIP Matrix audit", prompt: "Walk me through a DRIP matrix audit of this week." },
            { displayText: "10X Vision Map", prompt: "Render my 10X Vision Map for the next quarter." },
            { displayText: "Daily rocks", prompt: "What three rocks am I moving today?" },
            { displayText: "1-3-1 problem", prompt: "Here is a problem. Use the 1-3-1 frame." },
          ],
        }}
      />
    </div>
  );
}
