const capability = process.argv[2] ?? 'This capability';
console.error(`${capability} is not implemented in Career Agent Stack v0.1.`);
process.exitCode = 2;
