export class Result<T> {
  private constructor(
    public readonly isSuccess: boolean,
    public readonly value?: T,
    public readonly error?: string,
    public readonly code?: string
  ) {}

  static ok<T>(value: T): Result<T> {
    return new Result(true, value);
  }

  static fail<T>(error: string, code?: string): Result<T> {
    return new Result<T>(false, undefined, error, code);
  }

  getValue(): T {
    if (!this.isSuccess || this.value === undefined) {
      throw new Error(this.error ?? 'Result has no value');
    }
    return this.value;
  }
}
