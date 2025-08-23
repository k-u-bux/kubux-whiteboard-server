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
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
      in {

        devShells = {
          default = pkgs.mkShell {
            buildInputs = [
              pkgs.nodejs
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
              license = licenses.asl2;
              platforms = platforms.all;
            };
          };
        };
      }
    );
}
