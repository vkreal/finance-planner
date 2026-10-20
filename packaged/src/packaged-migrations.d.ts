// Type declaration for the build-time virtual module that inlines the
// live tree's drizzle/*.sql migration files (see the resolver plugin in
// packaged/build-shared.mjs). The packaged database applies exactly the
// migrations the live server runs, in filename order.
declare module "packaged-migrations" {
  export const MIGRATIONS: string[];
  export const MIGRATION_NAMES: string[];
}
