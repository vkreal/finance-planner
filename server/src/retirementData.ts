// Historical annual returns, 1928–2025.
// Stocks & bonds: Aswath Damodaran, NYU Stern — "Historical Returns on
// Stocks, Bonds and Bills" (S&P 500 total return incl. dividends;
// US 10-year Treasury bond total return), updated Jan 5, 2026.
// https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html
// Inflation: U.S. Bureau of Labor Statistics, CPI-U annual average
// percent change (public-domain BLS series, via BLS published tables).
// Values are nominal percent returns for that calendar year.
//
// FULL AUDIT (2026-10-11): every one of the 98 years × 3 series
// (294 values) was compared programmatically against the published
// sources — stocks and bonds against Damodaran's table as updated
// January 5, 2026 (the same update this dataset was taken from),
// CPI against the BLS CPI-U annual-average percent changes.
// Tolerance: the sources publish to 2 decimals (stocks/bonds) and
// 1 decimal (CPI); every embedded value matched its source value
// to within rounding (|difference| ≤ 0.011). Zero discrepancies,
// zero corrections. Re-run this comparison after any edit here.
export type HistYear = {
  year: number;
  stockPct: number;
  bondPct: number;
  cpiPct: number;
};

export const HISTORICAL: HistYear[] = [
  { year: 1928, stockPct: 43.81, bondPct: 0.84, cpiPct: -1.7 },
  { year: 1929, stockPct: -8.3, bondPct: 4.2, cpiPct: 0.0 },
  { year: 1930, stockPct: -25.12, bondPct: 4.54, cpiPct: -2.3 },
  { year: 1931, stockPct: -43.84, bondPct: -2.56, cpiPct: -9.0 },
  { year: 1932, stockPct: -8.64, bondPct: 8.79, cpiPct: -9.9 },
  { year: 1933, stockPct: 49.98, bondPct: 1.86, cpiPct: -5.1 },
  { year: 1934, stockPct: -1.19, bondPct: 7.96, cpiPct: 3.1 },
  { year: 1935, stockPct: 46.74, bondPct: 4.47, cpiPct: 2.2 },
  { year: 1936, stockPct: 31.94, bondPct: 5.02, cpiPct: 1.5 },
  { year: 1937, stockPct: -35.34, bondPct: 1.38, cpiPct: 3.6 },
  { year: 1938, stockPct: 29.28, bondPct: 4.21, cpiPct: -2.1 },
  { year: 1939, stockPct: -1.1, bondPct: 4.41, cpiPct: -1.4 },
  { year: 1940, stockPct: -10.67, bondPct: 5.4, cpiPct: 0.7 },
  { year: 1941, stockPct: -12.77, bondPct: -2.02, cpiPct: 5.0 },
  { year: 1942, stockPct: 19.17, bondPct: 2.29, cpiPct: 10.9 },
  { year: 1943, stockPct: 25.06, bondPct: 2.49, cpiPct: 6.1 },
  { year: 1944, stockPct: 19.03, bondPct: 2.58, cpiPct: 1.7 },
  { year: 1945, stockPct: 35.82, bondPct: 3.8, cpiPct: 2.3 },
  { year: 1946, stockPct: -8.43, bondPct: 3.13, cpiPct: 8.3 },
  { year: 1947, stockPct: 5.2, bondPct: 0.92, cpiPct: 14.4 },
  { year: 1948, stockPct: 5.7, bondPct: 1.95, cpiPct: 8.1 },
  { year: 1949, stockPct: 18.3, bondPct: 4.66, cpiPct: -1.2 },
  { year: 1950, stockPct: 30.81, bondPct: 0.43, cpiPct: 1.3 },
  { year: 1951, stockPct: 23.68, bondPct: -0.3, cpiPct: 7.9 },
  { year: 1952, stockPct: 18.15, bondPct: 2.27, cpiPct: 1.9 },
  { year: 1953, stockPct: -1.21, bondPct: 4.14, cpiPct: 0.8 },
  { year: 1954, stockPct: 52.56, bondPct: 3.29, cpiPct: 0.7 },
  { year: 1955, stockPct: 32.6, bondPct: -1.34, cpiPct: -0.4 },
  { year: 1956, stockPct: 7.44, bondPct: -2.26, cpiPct: 1.5 },
  { year: 1957, stockPct: -10.46, bondPct: 6.8, cpiPct: 3.3 },
  { year: 1958, stockPct: 43.72, bondPct: -2.1, cpiPct: 2.8 },
  { year: 1959, stockPct: 12.06, bondPct: -2.65, cpiPct: 0.7 },
  { year: 1960, stockPct: 0.34, bondPct: 11.64, cpiPct: 1.7 },
  { year: 1961, stockPct: 26.64, bondPct: 2.06, cpiPct: 1.0 },
  { year: 1962, stockPct: -8.81, bondPct: 5.69, cpiPct: 1.0 },
  { year: 1963, stockPct: 22.61, bondPct: 1.68, cpiPct: 1.3 },
  { year: 1964, stockPct: 16.42, bondPct: 3.73, cpiPct: 1.3 },
  { year: 1965, stockPct: 12.4, bondPct: 0.72, cpiPct: 1.6 },
  { year: 1966, stockPct: -9.97, bondPct: 2.91, cpiPct: 2.9 },
  { year: 1967, stockPct: 23.8, bondPct: -1.58, cpiPct: 3.1 },
  { year: 1968, stockPct: 10.81, bondPct: 3.27, cpiPct: 4.2 },
  { year: 1969, stockPct: -8.24, bondPct: -5.01, cpiPct: 5.5 },
  { year: 1970, stockPct: 3.56, bondPct: 16.75, cpiPct: 5.7 },
  { year: 1971, stockPct: 14.22, bondPct: 9.79, cpiPct: 4.4 },
  { year: 1972, stockPct: 18.76, bondPct: 2.82, cpiPct: 3.2 },
  { year: 1973, stockPct: -14.31, bondPct: 3.66, cpiPct: 6.2 },
  { year: 1974, stockPct: -25.9, bondPct: 1.99, cpiPct: 11.0 },
  { year: 1975, stockPct: 37.0, bondPct: 3.61, cpiPct: 9.1 },
  { year: 1976, stockPct: 23.83, bondPct: 15.98, cpiPct: 5.8 },
  { year: 1977, stockPct: -6.98, bondPct: 1.29, cpiPct: 6.5 },
  { year: 1978, stockPct: 6.51, bondPct: -0.78, cpiPct: 7.6 },
  { year: 1979, stockPct: 18.52, bondPct: 0.67, cpiPct: 11.3 },
  { year: 1980, stockPct: 31.74, bondPct: -2.99, cpiPct: 13.5 },
  { year: 1981, stockPct: -4.7, bondPct: 8.2, cpiPct: 10.3 },
  { year: 1982, stockPct: 20.42, bondPct: 32.81, cpiPct: 6.2 },
  { year: 1983, stockPct: 22.34, bondPct: 3.2, cpiPct: 3.2 },
  { year: 1984, stockPct: 6.15, bondPct: 13.73, cpiPct: 4.3 },
  { year: 1985, stockPct: 31.24, bondPct: 25.71, cpiPct: 3.6 },
  { year: 1986, stockPct: 18.49, bondPct: 24.28, cpiPct: 1.9 },
  { year: 1987, stockPct: 5.81, bondPct: -4.96, cpiPct: 3.6 },
  { year: 1988, stockPct: 16.54, bondPct: 8.22, cpiPct: 4.1 },
  { year: 1989, stockPct: 31.48, bondPct: 17.69, cpiPct: 4.8 },
  { year: 1990, stockPct: -3.06, bondPct: 6.24, cpiPct: 5.4 },
  { year: 1991, stockPct: 30.23, bondPct: 15.0, cpiPct: 4.2 },
  { year: 1992, stockPct: 7.49, bondPct: 9.36, cpiPct: 3.0 },
  { year: 1993, stockPct: 9.97, bondPct: 14.21, cpiPct: 3.0 },
  { year: 1994, stockPct: 1.33, bondPct: -8.04, cpiPct: 2.6 },
  { year: 1995, stockPct: 37.2, bondPct: 23.48, cpiPct: 2.8 },
  { year: 1996, stockPct: 22.68, bondPct: 1.43, cpiPct: 3.0 },
  { year: 1997, stockPct: 33.1, bondPct: 9.94, cpiPct: 2.3 },
  { year: 1998, stockPct: 28.34, bondPct: 14.92, cpiPct: 1.6 },
  { year: 1999, stockPct: 20.89, bondPct: -8.25, cpiPct: 2.2 },
  { year: 2000, stockPct: -9.03, bondPct: 16.66, cpiPct: 3.4 },
  { year: 2001, stockPct: -11.85, bondPct: 5.57, cpiPct: 2.8 },
  { year: 2002, stockPct: -21.97, bondPct: 15.12, cpiPct: 1.6 },
  { year: 2003, stockPct: 28.36, bondPct: 0.38, cpiPct: 2.3 },
  { year: 2004, stockPct: 10.74, bondPct: 4.49, cpiPct: 2.7 },
  { year: 2005, stockPct: 4.83, bondPct: 2.87, cpiPct: 3.4 },
  { year: 2006, stockPct: 15.61, bondPct: 1.96, cpiPct: 3.2 },
  { year: 2007, stockPct: 5.48, bondPct: 10.21, cpiPct: 2.8 },
  { year: 2008, stockPct: -36.55, bondPct: 20.1, cpiPct: 3.8 },
  { year: 2009, stockPct: 25.94, bondPct: -11.12, cpiPct: -0.4 },
  { year: 2010, stockPct: 14.82, bondPct: 8.46, cpiPct: 1.6 },
  { year: 2011, stockPct: 2.1, bondPct: 16.04, cpiPct: 3.2 },
  { year: 2012, stockPct: 15.89, bondPct: 2.97, cpiPct: 2.1 },
  { year: 2013, stockPct: 32.15, bondPct: -9.1, cpiPct: 1.5 },
  { year: 2014, stockPct: 13.52, bondPct: 10.75, cpiPct: 1.6 },
  { year: 2015, stockPct: 1.38, bondPct: 1.28, cpiPct: 0.1 },
  { year: 2016, stockPct: 11.77, bondPct: 0.69, cpiPct: 1.3 },
  { year: 2017, stockPct: 21.61, bondPct: 2.8, cpiPct: 2.1 },
  { year: 2018, stockPct: -4.23, bondPct: -0.02, cpiPct: 2.4 },
  { year: 2019, stockPct: 31.21, bondPct: 9.64, cpiPct: 1.8 },
  { year: 2020, stockPct: 18.02, bondPct: 11.33, cpiPct: 1.2 },
  { year: 2021, stockPct: 28.47, bondPct: -4.42, cpiPct: 4.7 },
  { year: 2022, stockPct: -18.04, bondPct: -17.83, cpiPct: 8.0 },
  { year: 2023, stockPct: 26.06, bondPct: 3.88, cpiPct: 4.1 },
  { year: 2024, stockPct: 24.88, bondPct: -1.64, cpiPct: 2.9 },
  { year: 2025, stockPct: 17.78, bondPct: 7.8, cpiPct: 2.6 },
];

export const HISTORICAL_SOURCE_NAME =
  "Damodaran (NYU Stern) — Historical Returns on Stocks, Bonds and Bills, 1928–2025; inflation: U.S. Bureau of Labor Statistics CPI-U";
export const HISTORICAL_SOURCE_URL =
  "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html";
