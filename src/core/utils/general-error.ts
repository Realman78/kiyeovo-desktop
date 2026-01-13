export const generalErrorHandler = (error: unknown, context?: string) => {
  console.log(error instanceof Error ? error.message : String(error), context);
};