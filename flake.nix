{
  description = "WhiteboardServer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
  let
    nixpkgs-config = { 
      allowBroken = true;
      allowUnfree = true; 
      permittedInsecurePackages = [];
    };
  in
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system; config = nixpkgs-config; };
      in {

        devShells = {
          default = pkgs.mkShell {
            buildInputs = [
              pkgs.code-cursor-fhs
              pkgs.nodejs
              pkgs.nodePackages.ts-node
              pkgs.typescript
              pkgs.jq
            ];

            shellHook = ''
              echo "Current directory:"
              pwd
              echo "Files in directory:"
              ls -F
              if [ ! -f "package.json" ]; then
                echo "ERROR: package.json not found. This is the root cause."
              fi
              if [ ! -d "node_modules" ]; then
                echo "Installing npm dependencies..."
                npm install
              fi
              echo "WhiteboardServer development environment is ready."
            '';
          };
        };

        packages = {
          default = pkgs.stdenv.mkDerivation {
            pname = "WhiteboardServer";
            version = "0.0.1";

            src = ./.;

            nativeBuildInputs = [
              pkgs.code-cursor-fhs
              pkgs.nodejs
              pkgs.nodePackages.ts-node
              pkgs.typescript
              pkgs.jq
            ];

            buildPhase = ''
              npm install
              npm run build
            '';

            installPhase = ''
              mkdir -p $out
              cp -r * $out/
            '';

            meta = with pkgs.lib; {
              description = "WhiteboardServer";
              license = licenses.asl20;
              platforms = platforms.all;
            };
          };
        };
      }
    );
}
