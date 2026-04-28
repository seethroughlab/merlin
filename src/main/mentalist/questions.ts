/**
 * Mentalist Question Bank
 *
 * Pre-written templates for key moments in the reading.
 * Gemini can call get_question_template to get varied inspiration.
 */

/**
 * Opening questions for the intro phase
 */
export const INTRO_OPENERS = [
  "Before we begin... may I ask what brought you here today?",
  "Tell me - are you someone who trusts their intuition?",
  "I notice how you chose to sit. Is that your natural posture?",
  "What's the first word that comes to mind when I say 'secret'?",
  "Do you consider yourself an open book, or do you keep things hidden?",
  "When was the last time someone truly surprised you?",
  "Close your eyes for a moment and take a breath. What do you feel?",
  "Your hands tell a story. Do you know what they're saying right now?",
];

/**
 * Transition questions for the reading phase
 */
export const TRANSITION_QUESTIONS = [
  "Let's try something different. Close your eyes for a moment...",
  "I want to shift our focus. Think of someone important to you...",
  "There's something we haven't touched on yet...",
  "I'm going to say a word. Tell me what memory surfaces: 'childhood'",
  "Your energy just shifted. What crossed your mind?",
  "Let me ask you something more personal...",
  "I sense there's a question you want to ask me. What is it?",
  "Think of a decision you've been avoiding. Don't tell me what it is.",
  "What would surprise the people who think they know you?",
  "If your body could speak right now, what would it say?",
];

/**
 * Setup phrases for dramatic reveals
 */
export const REVEAL_SETUPS = [
  "I'm going to tell you something now that you already know, deep down...",
  "Throughout our conversation, I've been noticing something consistent...",
  "What I'm about to say may surprise you, or perhaps confirm what you've felt...",
  "There's a pattern here that keeps emerging...",
  "Let me share what I've observed, and you tell me if I'm close...",
  "This is what your body has been telling me all along...",
  "I rarely say this with such certainty, but...",
  "The truth is written in your shoulders, your eyes, your breath...",
];

/**
 * Probing follow-up questions
 */
export const PROBING_QUESTIONS = [
  "Tell me more about that...",
  "What does that bring up for you?",
  "And how does that make you feel right now?",
  "Is that something you think about often?",
  "When did you first realize that about yourself?",
  "Who else knows this about you?",
  "What would happen if you let that go?",
  "Does that surprise you to hear?",
];

/**
 * Physical prompts that encourage movement/reaction
 */
export const PHYSICAL_PROMPTS = [
  "Take a deep breath and tell me the first thing that comes to mind.",
  "Roll your shoulders back. Does that feel different?",
  "Look directly at me. What do you see?",
  "Place your hand on your chest. What do you notice?",
  "Let your face relax completely. How does that change things?",
  "Uncross your arms for a moment. How does that feel?",
];

/**
 * Get a random template from a category
 */
export function getRandomTemplate(
  category: 'intro' | 'transition' | 'reveal' | 'probing' | 'physical'
): string {
  const templates = {
    intro: INTRO_OPENERS,
    transition: TRANSITION_QUESTIONS,
    reveal: REVEAL_SETUPS,
    probing: PROBING_QUESTIONS,
    physical: PHYSICAL_PROMPTS,
  };

  const list = templates[category];
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Get multiple templates from a category (for variety in choices)
 */
export function getTemplates(
  category: 'intro' | 'transition' | 'reveal' | 'probing' | 'physical',
  count = 3
): string[] {
  const templates = {
    intro: INTRO_OPENERS,
    transition: TRANSITION_QUESTIONS,
    reveal: REVEAL_SETUPS,
    probing: PROBING_QUESTIONS,
    physical: PHYSICAL_PROMPTS,
  };

  const list = [...templates[category]];
  const results: string[] = [];

  for (let i = 0; i < Math.min(count, list.length); i++) {
    const idx = Math.floor(Math.random() * list.length);
    results.push(list.splice(idx, 1)[0]);
  }

  return results;
}
