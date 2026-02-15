const withTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n`;

export const writeStdoutLine = (value: string): void => {
  process.stdout.write(withTrailingNewline(value));
};

export const writeStderrLine = (value: string): void => {
  process.stderr.write(withTrailingNewline(value));
};
