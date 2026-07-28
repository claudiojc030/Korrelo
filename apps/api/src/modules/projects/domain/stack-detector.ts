import type { DetectedStack } from "./detected-stack";

export const STACK_DETECTOR = Symbol("STACK_DETECTOR");

export interface StackDetector {
  detect(projectPath: string): Promise<DetectedStack>;
}
