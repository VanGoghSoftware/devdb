export class DevdbError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
