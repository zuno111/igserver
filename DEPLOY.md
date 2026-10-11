# igServer 배포 (Windows 실행파일 받기)

목표: GitHub에 올리면 Actions가 Windows/Mac/Linux 단독 실행파일을 자동 빌드한다. 받아서 더블클릭하면 Node 없이 켜진다.

## 가장 쉬운 길 — 저장소만 만들면 나머지는 자동

1. github.com/new 에서 빈 저장소를 하나 만든다.
   - 이름: `igserver`
   - Private 선택
   - README·.gitignore·license는 **체크하지 않음** (빈 저장소로)
   - Create repository

2. 그게 전부다. 저장소를 만들었다고 알려주면 푸시는 대신 끝내준다.
   푸시되는 순간 Actions의 "단독 실행파일 빌드"가 자동 실행된다(main 브랜치 push 트리거).

3. 빌드가 끝나면(약 3~5분) 저장소 Actions 탭 → 최신 실행 → Artifacts에서
   `igserver-win-x64` 를 받는다. 압축 풀고 `igserver.exe` 더블클릭.

## 직접 올릴 때 (본인 PC에 git/gh가 있으면)

GitHub CLI(gh)가 설치·로그인돼 있으면 이 폴더에서 한 줄:
```
gh repo create igserver --private --source=. --push
```
또는 git만 있으면, 1번에서 빈 저장소를 만든 뒤:
```
git init && git add -A && git commit -m "igServer"
git branch -M main
git remote add origin https://github.com/zuno111/igserver.git
git push -u origin main
```

## 빌드 후 Release로 배포하고 싶을 때

버전 태그를 올리면 실행파일이 Release에 zip으로 자동 첨부된다:
```
git tag v1.0.0 && git push origin v1.0.0
```
