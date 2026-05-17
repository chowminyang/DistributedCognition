# LinkedIn Post Draft

I bought a Mac for my AI to work.

That is the hook, but it is also the design principle.

I wanted the computation to happen locally. I wanted the working memory to live on my own machine. I wanted to be able to monitor the agents' local progress from the ChatGPT/Codex app, without needing to sit in a terminal all day.

The sentence I keep coming back to is:

I outsourced computation, manual labour, and memory.  
I kept understanding and wisdom with me.

My problem was not that I did not think enough. It was that I was reflecting constantly across too many disconnected meetings, drafts, talks, projects, decisions, and half-formed ideas. A lot of that thinking stayed in my head, or disappeared into chat threads and voice notes, before it became concrete enough to help me.

So I built a local system I call Distributed Cognition.

The workflow is simple:

- I send quick text notes or voice reflections to a private assistant.
- It transcribes, classifies, and structures them.
- It separates raw reflections, decisions, open questions, risks, and possible next actions.
- It stores the memory locally.
- It reasons alongside me, challenges my assumptions, and asks better questions.
- When a thread deserves more work, it turns the thought into a prompt, plan, and acceptance criteria for local Codex agents.
- I can then monitor those local agents from the ChatGPT/Codex app.

The technical shape is deliberately boring in the best way:

- WhatsApp is the low-friction capture surface.
- Baileys handles the WhatsApp bridge.
- NanoClaw runs locally in Docker.
- OpenAI models handle transcription, classification, synthesis, and reasoning.
- Model routing lets faster models handle lightweight work, while deeper models handle synthesis and harder reasoning.
- Web search is available when a question needs current external context.
- Markdown files form the local, readable second-brain layer.
- Codex local agents take the larger action tasks: research, writing, slide-making, document creation, coding, testing.
- The ChatGPT/Codex app lets me monitor local agent progress without needing to live in the command line.

But the most important technical layer is Mnemon.

Mnemon is not there to remember every single thing I say. That would just create a larger mess.

Its job is to help decide what is important and what is less important. In practice, it is the layer that distinguishes keys and pivots from noise.

For me, the important things are:

- stable facts that should shape future answers
- decisions and decision leanings
- changes of mind
- recurring themes
- project pivots
- unresolved tensions
- questions that keep coming back
- links between ideas that I might otherwise miss

The less important things are still allowed to exist, but they stay closer to the raw archive: passing context, one-off phrasing, temporary uncertainty, conversational clutter, and details that do not need to shape future reasoning.

That distinction matters. A second brain should not be a landfill. It should know the difference between a transcript, a note, a durable memory, and a pivot.

The full pipeline is roughly:

1. Raw sources: voice notes, quick messages, meeting reflections, web clips, drafts.
2. Extraction: structured Markdown plus Mnemon memories for the durable parts.
3. Synthesis: Obsidian-readable wiki pages, current project maps, decision logs, open questions, deadline watch.
4. Delegation: local Codex agents receive the work that needs research, writing, building, testing, or document creation.

This matters because a lot of knowledge work fails in the gap between reflection and concretisation.

I can have a good thought after a meeting. I can notice an important tension in a project. I can decide that an idea is not ready yet, or that a paper needs a different frame. But if those moments are not captured, labelled, revisited, and connected, they do not compound.

The real benefit has not been "AI productivity" in the generic sense.

The benefit is that my thinking now has a place to land.

Voice notes become structured notes.  
Vague thoughts become open questions.  
Decisions become auditable.  
Recurring themes become visible.  
Useful ideas can be handed off to agents for research, drafting, building, testing, or slide-making.

That feels like the right division of labour: outsource the pieces that machines are good at, while keeping the responsibility for meaning, judgement, and wisdom with the human.

For me, this is less "AI as replacement" and more "AI as cognitive infrastructure".

So now the shape is different.

Not just a second brain.

A second brain connected to an expandable team of brains and hands.

The part I am most interested in is not automation for its own sake. It is whether we can design systems that help us think better, remember more honestly, delegate more clearly, and remain more responsible for the work that matters.

Diagram below is the public version. It deliberately removes private details, project names, paths, and account information, but shows the basic shape of the system.

Suggested image: `docs/distributed-cognition-public-architecture.png`
