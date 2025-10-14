# zillit_server-boilerplate

# versioning
  - v1 folder has been added to all the directories where different versions are possible

# models
  - These will contain models/schema for database

# repositories
  - This will be a wrapper for **models**
  - Don't call model methods directly
  - These wrapper will use models

# services
  - This will contain independent services/business logic which will be pure functions
  - Services will call repositories

# controllers
  - This will be responsible for calling services

# routes
  - This will be exposed APIs which will call controllers

# Directory Structure
```
  ├── LICENSE
  ├── README.md
  ├── package-lock.json
  ├── package.json
  └── src
      ├── app.js
      ├── config
      │   ├── httpStatusCodes.js
      │   └── mongoDbConnect.js
      ├── controllers
      │   └── v1
      │       └── health.js
      ├── errors
      │   ├── BaseError.js
      │   └── CodeError.js
      ├── index.js
      ├── middlewares
      │   └── v1
      │       ├── cors.js
      │       ├── expressValidator.js
      │       ├── httplogger.js
      │       └── routeNotFound.js
      ├── models
      │   └── v1
      │       └── index.js
      ├── public
      │   └── test.json
      ├── repositories
      │   └── v1
      │       └── index.js
      ├── routes
      │   └── v1
      │       ├── health
      │       │   └── index.js
      │       └── index.js
      ├── services
      │   └── v1
      │       └── index.js
      ├── utils
      │   └── getLogPath.js
      └── validators
          └── v1
              └── index.js
```

# .npmrc
  needed for installation of zillit-lib
    ```
      npm i git+https://github.com/rockims/zillit_libs.git#main
    ```

  .npmrc content
  ```
    //npm.pkg.github.com/:_authToken=${GITHUB_PAT}
    registry=https://npm.pkg.github.com/rockims
  ```
